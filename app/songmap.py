from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import json
import os


class SongMapper:
    """Beat-aware, editable first-draft song form analysis."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def analyze(self, source: Path) -> dict:
        stat = source.stat()
        key = sha256(f"{source}:{stat.st_size}:{stat.st_mtime_ns}:v2".encode()).hexdigest()[:24]
        cache = self.root / f"{key}.json"
        if cache.is_file():
            return json.loads(cache.read_text(encoding="utf-8"))

        # Imported lazily: the production image includes librosa, while basic
        # library browsing and unit tests do not need the analysis stack.
        import librosa
        import numpy as np

        audio, sample_rate = librosa.load(source, sr=22_050, mono=True)
        duration = float(librosa.get_duration(y=audio, sr=sample_rate))
        if duration < 12:
            raise ValueError("The song is too short to build a useful form chart")
        hop = 512
        onset = librosa.onset.onset_strength(y=audio, sr=sample_rate, hop_length=hop)
        tempo_value, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset, sr=sample_rate, hop_length=hop
        )
        tempo = float(np.asarray(tempo_value).reshape(-1)[0])
        beat_times = librosa.frames_to_time(beat_frames, sr=sample_rate, hop_length=hop)
        if len(beat_times) < 16 or not 35 <= tempo <= 260:
            raise ValueError("A stable beat could not be detected in this song")

        chroma = librosa.feature.chroma_cqt(y=audio, sr=sample_rate, hop_length=hop)
        mfcc = librosa.feature.mfcc(y=audio, sr=sample_rate, n_mfcc=8, hop_length=hop)
        rms = librosa.feature.rms(y=audio, hop_length=hop)
        frame_count = min(chroma.shape[1], mfcc.shape[1], rms.shape[1], len(onset))
        features = np.vstack((chroma[:, :frame_count], mfcc[:, :frame_count], rms[:, :frame_count] * 20))
        features = librosa.util.normalize(features, axis=1)
        section_count = max(4, min(14, round(duration / 28)))
        raw_boundaries = librosa.segment.agglomerative(features, section_count)
        raw_times = librosa.frames_to_time(raw_boundaries, sr=sample_rate, hop_length=hop)

        boundaries = [0.0]
        for value in raw_times[1:]:
            nearest = float(beat_times[np.argmin(np.abs(beat_times - value))])
            if nearest - boundaries[-1] >= 8:
                boundaries.append(nearest)
        if duration - boundaries[-1] < 8 and len(boundaries) > 2:
            boundaries.pop()
        boundaries.append(duration)

        rms_values = rms[0, :frame_count]
        rms_floor, rms_ceiling = np.percentile(rms_values, [15, 85])
        onset_ceiling = max(float(np.percentile(onset, 90)), .0001)
        signatures: list[np.ndarray] = []
        letters: list[str] = []
        markers = []
        for index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
            start_frame = min(frame_count - 1, librosa.time_to_frames(start, sr=sample_rate, hop_length=hop))
            end_frame = max(start_frame + 1, min(frame_count, librosa.time_to_frames(end, sr=sample_rate, hop_length=hop)))
            signature = np.mean(features[:, start_frame:end_frame], axis=1)
            if index == 0:
                label, kind = "Intro", "intro"
            elif index == len(boundaries) - 2:
                label, kind = "Outro", "outro"
            else:
                match = None
                for prior, prior_signature in enumerate(signatures[1:], start=1):
                    denominator = np.linalg.norm(signature) * np.linalg.norm(prior_signature)
                    similarity = float(np.dot(signature, prior_signature) / denominator) if denominator else 0
                    if similarity >= .91:
                        match = letters[prior]
                        break
                letter = match or chr(65 + len({value for value in letters if value}))
                label, kind = f"Section {letter}", "section"
            signatures.append(signature)
            letters.append(label.removeprefix("Section ") if kind == "section" else "")
            beat_start = int(np.searchsorted(beat_times, start, side="left"))
            beat_end = int(np.searchsorted(beat_times, end, side="left"))
            bars = max(1, round((beat_end - beat_start) / 4))
            energy = float(np.mean(rms_values[start_frame:end_frame]))
            energy_ratio = (energy - rms_floor) / max(rms_ceiling - rms_floor, .0001)
            dynamics = "low" if energy_ratio < .34 else "high" if energy_ratio > .72 else "medium"
            density = float(np.mean(onset[start_frame:min(end_frame, len(onset))])) / onset_ceiling
            groove = "open" if density < .28 else "busy" if density > .62 else "steady"
            markers.append({
                "id": f"auto-{index}-{round(start * 100)}",
                "time": round(start, 2),
                "label": label,
                "note": f"{bars} bars · {dynamics} dynamics · {groove} texture",
                "kind": kind,
                "bar": beat_start // 4 + 1,
                "bars": bars,
                "confidence": .82 if kind != "section" else .68,
                "dynamics": dynamics,
                "groove": groove,
            })
        result = {
            "bpm": round(tempo),
            "time_signature": "4/4",
            "duration": round(duration, 2),
            "beats": [round(float(value), 3) for value in beat_times],
            "markers": markers,
            "method": "Beat-synchronous structural analysis",
        }
        temporary = cache.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, cache)
        return result
