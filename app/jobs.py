from __future__ import annotations

from array import array
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from queue import Queue
from threading import Lock, Thread
from typing import Callable
from urllib.request import urlopen
from uuid import uuid4
import json
import fcntl
import os
import re
import shutil
import subprocess
import sys
import time

from .config import Settings
from .library import MusicLibrary, Track


MODELS = {
    "scnet": {
        "name": "SCNet XL IHF",
        "description": "Highest measured drum SDR in the current MSST checkpoint table.",
    },
    "roformer": {
        "name": "BS-RoFormer-SW",
        "description": "A newer six-stem RoFormer with strong real-world separation.",
    },
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def create(self, track: Track, user: str = "") -> dict:
        job_id = uuid4().hex
        job = {
            "id": job_id,
            "track": track.as_dict(),
            "user": user,
            "status": "queued",
            "stage": "Waiting for the processing slot",
            "progress": 0,
            "created_at": _now(),
            "updated_at": _now(),
            "error": None,
            "activity": [
                {"at": _now(), "model": None, "message": "Job added to the processing queue"}
            ],
            "models": {
                key: {
                    **metadata,
                    "status": "queued",
                    "progress": 0,
                    "phase": "Waiting",
                    "detail": "Queued behind any active comparison",
                    "started_at": None,
                    "updated_at": _now(),
                    "elapsed_seconds": None,
                    "audio_url": None,
                    "download_url": None,
                }
                for key, metadata in MODELS.items()
            },
        }
        self.save(job)
        return job

    def path(self, job_id: str) -> Path:
        if not job_id.isalnum():
            raise KeyError(job_id)
        return self.root / job_id / "job.json"

    def save(self, job: dict) -> None:
        with self._lock:
            path = self.root / job["id"] / "job.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(job, indent=2), encoding="utf-8")
            os.replace(temporary, path)

    def get(self, job_id: str) -> dict:
        path = self.path(job_id)
        if not path.is_file():
            raise KeyError(job_id)
        with self._lock:
            return json.loads(path.read_text(encoding="utf-8"))

    def update(self, job_id: str, updater: Callable[[dict], None]) -> dict:
        job = self.get(job_id)
        updater(job)
        job["updated_at"] = _now()
        self.save(job)
        return deepcopy(job)

    def list(self, limit: int = 12) -> list[dict]:
        jobs = []
        for path in self.root.glob("*/job.json"):
            try:
                jobs.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        jobs.sort(key=lambda job: job.get("created_at", ""), reverse=True)
        return jobs[:limit]

    def assign_unowned(self, user: str) -> int:
        """Assign jobs created before user accounts existed to a default owner."""
        assigned = 0
        for job in self.list(10000):
            if job.get("user"):
                continue
            self.update(job["id"], lambda saved: saved.update(user=user))
            assigned += 1
        return assigned

    def output_path(self, job_id: str, model: str) -> Path:
        if model not in MODELS:
            raise KeyError(model)
        return self.root / job_id / model / "no-drums.flac"


class Processor:
    def __init__(self, settings: Settings, library: MusicLibrary, store: JobStore):
        self.settings = settings
        self.library = library
        self.store = store

    @contextmanager
    def _gpu_lease(self, report: Callable[[str, int, str], None]):
        """Serialize GPU models across every app sharing the lock mount."""
        lock_path = self.settings.gpu_lock_path
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = lock_path.open("a+")
        waiting_since = time.monotonic()
        report("Waiting for GPU", 4, "Waiting for the shared GPU processing slot")
        try:
            while True:
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    waited = round(time.monotonic() - waiting_since)
                    report(
                        "Waiting for GPU",
                        4,
                        f"Another separation is using the GPU · waiting {waited}s",
                    )
                    time.sleep(2)
            report("Model setup", 5, "Shared GPU slot acquired")
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            lock_file.close()

    def _run_gpu(
        self,
        command: list[str],
        report: Callable[[str, int, str], None],
        *,
        cwd: Path | None = None,
        on_output: Callable[[str, int | None], None] | None = None,
    ) -> None:
        with self._gpu_lease(report):
            for attempt in range(2):
                try:
                    self._run(command, cwd=cwd, on_output=on_output)
                    return
                except RuntimeError as exc:
                    if attempt or "cuda out of memory" not in str(exc).casefold():
                        raise
                    report(
                        "Recovering GPU memory",
                        5,
                        "GPU memory was busy; retrying separation once",
                    )
                    time.sleep(5)

    def _run(
        self,
        command: list[str],
        cwd: Path | None = None,
        on_output: Callable[[str, int | None], None] | None = None,
    ) -> None:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        buffer = ""
        recent_output: list[str] = []
        started = datetime.now(timezone.utc)
        while True:
            character = process.stdout.read(1)
            if character == "" and process.poll() is not None:
                break
            if (datetime.now(timezone.utc) - started).total_seconds() > self.settings.job_timeout_seconds:
                process.kill()
                raise TimeoutError(f"Command exceeded {self.settings.job_timeout_seconds} seconds")
            if character not in {"\r", "\n"}:
                buffer += character
                continue
            line = buffer.strip()
            buffer = ""
            if not line:
                continue
            recent_output.append(line)
            recent_output = recent_output[-30:]
            match = re.search(r"(?<!\d)(\d{1,3})%", line)
            percent = min(100, int(match.group(1))) if match else None
            if on_output is not None:
                on_output(line[-240:], percent)
        if buffer.strip():
            recent_output.append(buffer.strip())
        if process.returncode:
            tail = "\n".join(recent_output[-12:])
            raise RuntimeError(
                f"Command failed with exit code {process.returncode}"
                + (f":\n{tail}" if tail else "")
            )

    @staticmethod
    def _download(
        url: str,
        destination: Path,
        on_progress: Callable[[int, str], None] | None = None,
    ) -> None:
        if destination.is_file() and destination.stat().st_size > 0:
            if on_progress:
                on_progress(100, f"Using cached {destination.name}")
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(f"{destination.suffix}.part")
        with urlopen(url, timeout=120) as response, temporary.open("wb") as output:
            total = int(response.headers.get("Content-Length", "0"))
            downloaded = 0
            last_percent = -1
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                downloaded += len(chunk)
                percent = int(downloaded * 100 / total) if total else 0
                if on_progress and percent != last_percent:
                    on_progress(percent, f"Downloading {destination.name}")
                    last_percent = percent
        os.replace(temporary, destination)

    @staticmethod
    def _find_drum_stem(output_dir: Path) -> Path:
        candidates = [
            path
            for path in output_dir.rglob("*")
            if path.is_file()
            and path.suffix.lower() in {".wav", ".flac"}
            and "drum" in path.stem.casefold()
            and "no-drums" not in path.stem.casefold()
        ]
        if not candidates:
            raise RuntimeError("The model completed but did not produce a drum stem.")
        return max(candidates, key=lambda path: path.stat().st_size)

    def _make_drumless(self, source: Path, drums: Path, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        self._run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-i",
                str(drums),
                "-filter_complex",
                "[1:a]volume=-1[negative_drums];"
                "[0:a][negative_drums]amix=inputs=2:normalize=0[out]",
                "-map",
                "[out]",
                "-c:a",
                "flac",
                "-sample_fmt",
                "s32",
                str(destination),
            ]
        )

    @staticmethod
    def list_stems(job_root: Path, model: str) -> dict[str, Path]:
        stems_root = job_root / model / "stems"
        stems: dict[str, Path] = {}
        canonical = {"vocals", "drums", "bass", "guitar", "piano", "other"}
        for path in stems_root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in {".wav", ".flac"}:
                continue
            lowered = path.stem.casefold()
            matches = [
                name
                for name in canonical
                if lowered == name
                or lowered.endswith(f"_{name}")
                or lowered.endswith(f"-{name}")
            ]
            if matches:
                name = matches[0]
                current = stems.get(name)
                if current is None or path.stat().st_size > current.stat().st_size:
                    stems[name] = path
        return stems

    def waveform(
        self,
        job_id: str,
        model: str,
        points: int = 1600,
        mix_id: str = "",
    ) -> dict:
        """Build and cache display-ready waveform peaks for a completed mix."""
        source = (
            self.store.root / job_id / model / "mixes" / f"{mix_id}.flac"
            if mix_id
            else self.store.output_path(job_id, model)
        )
        if not source.is_file():
            raise KeyError(job_id)
        cache = source.parent / f"{source.stem}-waveform-{points}.json"
        if cache.is_file():
            try:
                cached = json.loads(cache.read_text(encoding="utf-8"))
                if cached.get("points") == points and cached.get("peaks"):
                    return cached
            except (OSError, json.JSONDecodeError):
                pass

        sample_rate = 4000
        try:
            completed = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(source),
                    "-map",
                    "0:a:0",
                    "-ac",
                    "1",
                    "-ar",
                    str(sample_rate),
                    "-f",
                    "s16le",
                    "pipe:1",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=min(300, self.settings.job_timeout_seconds),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Waveform decoding timed out") from exc
        if completed.returncode or not completed.stdout:
            detail = completed.stderr.decode("utf-8", errors="replace")[-500:]
            raise RuntimeError(detail or "Waveform decoding failed")
        samples = array("h")
        samples.frombytes(completed.stdout)
        if sys.byteorder != "little":
            samples.byteswap()
        bucket_size = max(1, (len(samples) + points - 1) // points)
        peaks = []
        for start in range(0, len(samples), bucket_size):
            peak = max(abs(value) for value in samples[start : start + bucket_size])
            peaks.append(round((peak / 32768) ** 0.55, 4))
        data = {
            "points": points,
            "sample_rate": sample_rate,
            "duration": round(len(samples) / sample_rate, 3),
            "peaks": peaks,
        }
        temporary = cache.with_suffix(f".tmp-{uuid4().hex}")
        temporary.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, cache)
        return data

    def render_stem_mix(
        self,
        job_id: str,
        model: str,
        excluded: list[str],
    ) -> tuple[Path, str]:
        if model not in MODELS:
            raise KeyError(model)
        job_root = self.store.root / job_id
        stems = self.list_stems(job_root, model)
        excluded_set = set(excluded)
        unknown = excluded_set - set(stems)
        if unknown:
            raise ValueError(f"Unknown stems: {', '.join(sorted(unknown))}")
        included = [name for name in sorted(stems) if name not in excluded_set]
        if not included:
            raise ValueError("At least one stem must remain in the mix")
        mix_id = sha256(",".join(sorted(excluded_set)).encode("utf-8")).hexdigest()[:12]
        destination = job_root / model / "mixes" / f"{mix_id}.flac"
        if destination.is_file():
            return destination, mix_id
        destination.parent.mkdir(parents=True, exist_ok=True)
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
        for name in included:
            command.extend(["-i", str(stems[name])])
        inputs = "".join(f"[{index}:a]" for index in range(len(included)))
        command.extend(
            [
                "-filter_complex",
                f"{inputs}amix=inputs={len(included)}:normalize=0[out]",
                "-map",
                "[out]",
                "-c:a",
                "flac",
                "-sample_fmt",
                "s32",
                str(destination),
            ]
        )
        self._run(command)
        return destination, mix_id

    def render_mp3(self, source: Path) -> Path:
        """Render and cache a high-quality MP3 beside any generated FLAC mix."""
        destination = source.with_suffix(".mp3")
        if destination.is_file() and destination.stat().st_mtime >= source.stat().st_mtime:
            return destination
        self._run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-map", "0:a:0", "-c:a", "libmp3lame",
            "-q:a", "2", str(destination),
        ])
        return destination

    def render_pitch_variant(
        self,
        job_id: str,
        model: str,
        source: Path,
        semitones: int,
    ) -> tuple[Path, str]:
        """Render and cache a tempo-preserving pitch shift for practice."""
        if model not in MODELS or not source.is_file():
            raise KeyError(model)
        if semitones < -12 or semitones > 12:
            raise ValueError("Pitch must be between -12 and +12 semitones")
        variant_id = sha256(f"{source.stem}:{semitones}".encode("utf-8")).hexdigest()[:12]
        destination = self.store.root / job_id / model / "pitches" / f"{variant_id}.flac"
        if destination.is_file():
            return destination, variant_id
        destination.parent.mkdir(parents=True, exist_ok=True)
        factor = 2 ** (semitones / 12)
        # All separated/rendered mixes are 44.1 kHz. Changing the interpreted
        # sample rate shifts pitch, then atempo restores the original duration.
        audio_filter = (
            f"asetrate=44100*{factor:.9f},aresample=44100,"
            f"atempo={1 / factor:.9f}"
        )
        self._run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(source), "-af", audio_filter,
                "-c:a", "flac", "-sample_fmt", "s32", str(destination),
            ]
        )
        return destination, variant_id

    def _prepare_source(self, source: Path, work_dir: Path) -> Path:
        prepared = work_dir / "input" / "source.wav"
        prepared.parent.mkdir(parents=True, exist_ok=True)
        self._run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-vn",
                "-ar",
                "44100",
                "-ac",
                "2",
                "-c:a",
                "pcm_s24le",
                str(prepared),
            ]
        )
        return prepared

    def run_scnet(
        self,
        source: Path,
        output_dir: Path,
        report: Callable[[str, int, str], None],
    ) -> Path:
        model_dir = self.settings.data_root / "models" / "scnet-xl-ihf"
        config_path = model_dir / "config_musdb18_scnet_xl_more_wide_v5.yaml"
        checkpoint_path = model_dir / "model_scnet_ep_36_sdr_10.0891.ckpt"
        self._download(
            self.settings.scnet_config_url,
            config_path,
            lambda percent, detail: report("Model setup", min(8, percent // 13), detail),
        )
        self._download(
            self.settings.scnet_model_url,
            checkpoint_path,
            lambda percent, detail: report("Model setup", 8 + int(percent * 0.12), detail),
        )
        separated = output_dir / "stems"
        separated.mkdir(parents=True, exist_ok=True)
        report("Separating stems", 20, "Loading SCNet XL IHF on the GPU")
        self._run_gpu(
            [
                "python",
                str(self.settings.msst_root / "inference.py"),
                "--model_type",
                "scnet",
                "--config_path",
                str(config_path),
                "--start_check_point",
                str(checkpoint_path),
                "--input_folder",
                str(output_dir.parent / "input"),
                "--store_dir",
                str(separated),
            ],
            report,
            cwd=self.settings.msst_root,
            on_output=lambda line, percent: report(
                "Separating stems",
                20 + int((percent or 0) * 0.7),
                line,
            ),
        )
        report("Locating drum stem", 92, "SCNet separation finished")
        return self._find_drum_stem(separated)

    def run_roformer(
        self,
        source: Path,
        output_dir: Path,
        report: Callable[[str, int, str], None],
    ) -> Path:
        separated = output_dir / "stems"
        separated.mkdir(parents=True, exist_ok=True)
        report("Model setup", 5, "Checking the RoFormer checkpoint cache")
        self._run_gpu(
            [
                sys.executable,
                "-m",
                "app.roformer_runner",
                "--input_folder",
                str(output_dir.parent / "input"),
                "--store_dir",
                str(separated),
                "--models_dir",
                str(self.settings.data_root / "models" / "bs-roformer"),
                "--chunk_size",
                str(self.settings.bs_roformer_chunk_size),
            ],
            report,
            on_output=lambda line, percent: report(
                "Separating stems",
                10 + int((percent or 0) * 0.8),
                line,
            ),
        )
        report("Locating drum stem", 92, "RoFormer separation finished")
        return self._find_drum_stem(separated)

    def process(self, job_id: str) -> None:
        job = self.store.get(job_id)
        source = self.library.path_for(job["track"]["id"])
        job_root = self.store.root / job_id

        def start(job_data: dict) -> None:
            job_data.update(status="processing", stage="Preparing source audio", progress=5)
            job_data.setdefault("activity", []).append(
                {"at": _now(), "model": None, "message": "Preparing a 44.1 kHz working copy"}
            )

        self.store.update(job_id, start)
        prepared = self._prepare_source(source, job_root)
        enabled = [
            ("scnet", self.settings.scnet_enabled, self.run_scnet),
            ("roformer", self.settings.bs_roformer_enabled, self.run_roformer),
        ]
        active_keys = [key for key, is_enabled, _ in enabled if is_enabled]
        model_span = 86 / max(1, len(active_keys))
        completed = 0
        failures = []

        for key, is_enabled, runner in enabled:
            current_job = self.store.get(job_id)
            current_model = current_job["models"][key]
            if (
                current_model.get("status") == "complete"
                and self.store.output_path(job_id, key).is_file()
            ):
                completed += 1
                continue

            if not is_enabled:
                self.store.update(
                    job_id,
                    lambda data, model=key: data["models"][model].update(
                        status="disabled", progress=0
                    ),
                )
                continue

            position = active_keys.index(key)
            started = datetime.now(timezone.utc)

            def model_start(
                data: dict,
                model: str = key,
                model_position: int = position,
            ) -> None:
                data["stage"] = f"Running {MODELS[model]['name']}"
                data["progress"] = round(10 + model_position * model_span)
                data["models"][model].update(
                    status="processing",
                    progress=1,
                    phase="Starting",
                    detail="Launching model process",
                    started_at=_now(),
                    updated_at=_now(),
                )
                data.setdefault("activity", []).append(
                    {
                        "at": _now(),
                        "model": model,
                        "message": f"Started {MODELS[model]['name']}",
                    }
                )

            self.store.update(job_id, model_start)
            model_dir = job_root / key
            incomplete_stems = model_dir / "stems"
            if incomplete_stems.is_dir():
                shutil.rmtree(incomplete_stems)
            incomplete_output = self.store.output_path(job_id, key)
            if incomplete_output.is_file():
                incomplete_output.unlink()

            last_report = {"phase": "", "progress": -1, "detail": ""}

            def report(phase: str, progress: int, detail: str, model: str = key) -> None:
                bounded = max(1, min(99, progress))
                clean_detail = detail.replace("\x1b", "").strip()[-240:]
                if (
                    phase == last_report["phase"]
                    and bounded == last_report["progress"]
                    and clean_detail == last_report["detail"]
                ):
                    return
                last_report.update(phase=phase, progress=bounded, detail=clean_detail)

                def apply(data: dict) -> None:
                    data["models"][model].update(
                        phase=phase,
                        progress=bounded,
                        detail=clean_detail,
                        updated_at=_now(),
                    )
                    base = 10 + position * model_span
                    data["progress"] = min(
                        96, round(base + bounded * model_span / 100)
                    )
                    data["stage"] = f"{MODELS[model]['name']} · {phase}"

                self.store.update(job_id, apply)

            try:
                drums = runner(prepared, model_dir, report)
                destination = self.store.output_path(job_id, key)
                report("Building drumless mix", 96, "Subtracting the isolated drum stem")
                self._make_drumless(prepared, drums, destination)
                elapsed = round((datetime.now(timezone.utc) - started).total_seconds(), 1)

                def model_done(data: dict, model: str = key, seconds: float = elapsed) -> None:
                    data["models"][model].update(
                        status="complete",
                        progress=100,
                        phase="Ready",
                        detail="Drumless FLAC is ready to play",
                        updated_at=_now(),
                        elapsed_seconds=seconds,
                        audio_url=f"/api/jobs/{job_id}/audio/{model}",
                        download_url=f"/api/jobs/{job_id}/download/{model}",
                    )
                    data.setdefault("activity", []).append(
                        {
                            "at": _now(),
                            "model": model,
                            "message": f"{MODELS[model]['name']} completed in {seconds}s",
                        }
                    )

                self.store.update(job_id, model_done)
                completed += 1
            except Exception as exc:  # model errors should not prevent the comparison peer
                failures.append(f"{MODELS[key]['name']}: {exc}")
                self.store.update(
                    job_id,
                    lambda data, model=key, message=str(exc): data["models"][model].update(
                        status="failed",
                        progress=0,
                        phase="Failed",
                        detail=message[-240:],
                        updated_at=_now(),
                        error=message,
                    ),
                )

        def finish(data: dict) -> None:
            data["progress"] = 100
            data["status"] = "complete" if completed else "failed"
            data["stage"] = (
                "RoFormer mix is ready"
                if data["models"]["roformer"]["status"] == "complete"
                else "Processing finished with limited results"
            )
            data["error"] = " | ".join(failures) if failures else None
            data.setdefault("activity", []).append(
                {
                    "at": _now(),
                    "model": None,
                    "message": "Comparison finished" if completed else "Comparison failed",
                }
            )

        self.store.update(job_id, finish)


class JobQueue:
    def __init__(self, processor: Processor, *, start_worker: bool = True):
        self.processor = processor
        self.queue: Queue[str] = Queue()
        self.thread = (
            Thread(target=self._worker, name="audio-job-worker", daemon=True)
            if start_worker
            else None
        )
        if self.thread is not None:
            self.thread.start()
        self.recover_pending()

    def submit(self, job_id: str) -> None:
        self.queue.put(job_id)

    def recover_pending(self) -> list[str]:
        recoverable: list[str] = []
        finalized_tracks: set[str] = set()
        active_tracks: set[str] = set()

        for job in self.processor.store.list(10000):
            track_id = job.get("track", {}).get("id")
            if not track_id:
                continue
            if job.get("status") == "complete":
                finalized_tracks.add(track_id)
                continue
            retryable_failure = (
                job.get("status") == "failed"
                and job.get("recovery_count", 0) < 3
                and job.get("models", {}).get("roformer", {}).get("status")
                != "complete"
            )
            if job.get("status") not in {"queued", "processing"} and not retryable_failure:
                continue
            if track_id in finalized_tracks or track_id in active_tracks:
                self.processor.store.update(
                    job["id"],
                    lambda data: data.update(
                        status="superseded",
                        stage="Replaced by a newer comparison",
                        error=None,
                    ),
                )
                continue

            active_tracks.add(track_id)

            def mark_recovered(data: dict) -> None:
                data.update(
                    status="queued",
                    stage="Recovering after app restart",
                    error=None,
                    recovery_count=data.get("recovery_count", 0) + 1,
                )
                for model in data["models"].values():
                    if model.get("status") in {"processing", "failed"}:
                        model.update(
                            status="queued",
                            phase="Recovering",
                            detail="Automatically resuming after an app restart",
                            updated_at=_now(),
                        )
                data.setdefault("activity", []).append(
                    {
                        "at": _now(),
                        "model": None,
                        "message": "Interrupted job recovered automatically",
                    }
                )

            self.processor.store.update(job["id"], mark_recovered)
            recoverable.append(job["id"])

        for job_id in reversed(recoverable):
            self.submit(job_id)
        return recoverable

    def _worker(self) -> None:
        while True:
            job_id = self.queue.get()
            try:
                self.processor.process(job_id)
            except Exception as exc:
                self.processor.store.update(
                    job_id,
                    lambda data, message=str(exc): data.update(
                        status="failed",
                        stage="Processing failed",
                        error=message,
                    ),
                )
            finally:
                self.queue.task_done()
