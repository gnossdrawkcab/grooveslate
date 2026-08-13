from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from threading import Lock
from uuid import uuid4
import json
import os
import struct


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


NOTE_FAMILIES = {
    35: "kick", 36: "kick", 31: "snare", 34: "snare", 38: "snare", 40: "snare",
    37: "snare", 39: "snare", 42: "hi-hat", 44: "hi-hat", 46: "hi-hat",
    22: "hi-hat", 26: "hi-hat", 41: "tom", 43: "tom", 45: "tom", 47: "tom",
    48: "tom", 50: "tom", 49: "crash", 52: "crash", 55: "crash", 57: "crash",
    51: "ride", 53: "ride", 59: "ride",
}


def sanitize_midi_events(raw: object) -> list[dict]:
    """Validate browser MIDI capture without trusting its shape or ranges."""
    if not isinstance(raw, list) or len(raw) > 100_000:
        raise ValueError("MIDI capture is not valid")
    events: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("MIDI capture is not valid")
        kind = item.get("kind")
        if kind not in {"note", "cc"}:
            continue
        event = {
            "kind": kind,
            "time_ms": round(max(0.0, min(float(item.get("time_ms", 0)), 86_400_000)), 2),
            "channel": max(0, min(int(item.get("channel", 9)), 15)),
        }
        if kind == "note":
            event["note"] = max(0, min(int(item.get("note", 0)), 127))
            event["velocity"] = max(1, min(int(item.get("velocity", 1)), 127))
        else:
            event["control"] = max(0, min(int(item.get("control", 0)), 127))
            event["value"] = max(0, min(int(item.get("value", 0)), 127))
        events.append(event)
    return sorted(events, key=lambda event: event["time_ms"])


def _timing_metrics(events: list[dict], bpm: int) -> dict:
    notes = [event for event in events if event["kind"] == "note"]
    if not notes:
        return {"mean_offset_ms": None, "pocket_score": None, "grid": "1/16"}
    grid = 60_000 / max(30, min(bpm, 300)) / 4
    phases = [event["time_ms"] % grid for event in notes]
    candidates = phases if len(phases) <= 240 else phases[:: max(1, len(phases) // 240)]
    def error(phase: float) -> float:
        return sum(abs((value - phase + grid / 2) % grid - grid / 2) for value in phases) / len(phases)
    mean_offset = min(error(phase) for phase in candidates)
    score = round(max(0, min(100, 100 - mean_offset / (grid / 2) * 100)))
    return {"mean_offset_ms": round(mean_offset, 1), "pocket_score": score, "grid": "1/16"}


def analyze_midi(events: list[dict], bpm: int, markers: list[dict], duration: float) -> dict:
    notes = [event for event in events if event["kind"] == "note"]
    velocities = [event["velocity"] for event in notes]
    pieces: dict[str, int] = {}
    for event in notes:
        family = NOTE_FAMILIES.get(event["note"], "other")
        pieces[family] = pieces.get(family, 0) + 1
    sections = []
    ordered = sorted(markers, key=lambda marker: marker.get("time", 0))
    boundaries = ordered or [{"label": "Full take", "time": 0}]
    for index, marker in enumerate(boundaries):
        start = float(marker.get("time", 0)) * 1000
        end = (float(boundaries[index + 1].get("time", duration)) * 1000
               if index + 1 < len(boundaries) else duration * 1000)
        section_events = [event for event in notes if start <= event["time_ms"] < end]
        metrics = _timing_metrics(section_events, bpm)
        sections.append({
            "label": str(marker.get("label", "Section"))[:40],
            "start": round(start / 1000, 2),
            "end": round(end / 1000, 2),
            "hits": len(section_events),
            **metrics,
        })
    return {
        "event_count": len(events),
        "hit_count": len(notes),
        "bpm": bpm,
        "velocity": {
            "average": round(sum(velocities) / len(velocities), 1) if velocities else None,
            "minimum": min(velocities) if velocities else None,
            "maximum": max(velocities) if velocities else None,
            "dynamic_range": max(velocities) - min(velocities) if velocities else None,
        },
        "pieces": pieces,
        **_timing_metrics(notes, bpm),
        "sections": sections,
    }


def _variable_length(value: int) -> bytes:
    buffer = value & 0x7f
    output = bytearray([buffer])
    while value := value >> 7:
        buffer = (value & 0x7f) | 0x80
        output.insert(0, buffer)
    return bytes(output)


def midi_file(events: list[dict], bpm: int) -> bytes:
    """Build a portable format-0 MIDI file from the editable raw capture."""
    division = 480
    micros_per_quarter = round(60_000_000 / bpm)
    timed: list[tuple[int, int, bytes]] = [(0, 0, b"\xff\x51\x03" + micros_per_quarter.to_bytes(3, "big"))]
    for event in events:
        tick = round(event["time_ms"] * bpm * division / 60_000)
        channel = event.get("channel", 9) & 0x0f
        if event["kind"] == "note":
            timed.append((tick, 1, bytes([0x90 | channel, event["note"], event["velocity"]])))
            timed.append((tick + max(1, division // 32), 2, bytes([0x80 | channel, event["note"], 0])))
        elif event["kind"] == "cc":
            timed.append((tick, 0, bytes([0xB0 | channel, event["control"], event["value"]])))
    timed.sort(key=lambda item: (item[0], item[1]))
    track = bytearray()
    previous = 0
    for tick, _, message in timed:
        track.extend(_variable_length(max(0, tick - previous)))
        track.extend(message)
        previous = tick
    track.extend(b"\x00\xff\x2f\x00")
    return (b"MThd" + struct.pack(">IHHH", 6, 0, 1, division)
            + b"MTrk" + struct.pack(">I", len(track)) + bytes(track))


class PracticeStore:
    """Persistent, per-user charts, practice settings, and recorded takes."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    @staticmethod
    def _user_key(user: str) -> str:
        return sha256(user.casefold().encode("utf-8")).hexdigest()[:20]

    def session_root(self, user: str, job_id: str) -> Path:
        if not job_id.isalnum():
            raise KeyError(job_id)
        return self.root / self._user_key(user) / job_id

    def session_path(self, user: str, job_id: str) -> Path:
        return self.session_root(user, job_id) / "session.json"

    def _default(self, user: str, job_id: str) -> dict:
        return {
            "job_id": job_id,
            "user": user,
            "markers": [],
            "settings": {
                "bpm": 120,
                "count_in_bars": 2,
                "metronome": False,
                "backing_volume": 0.8,
            },
            "takes": [],
            "updated_at": _now(),
        }

    def get(self, user: str, job_id: str) -> dict:
        path = self.session_path(user, job_id)
        if not path.is_file():
            return self._default(user, job_id)
        with self._lock:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return self._default(user, job_id)
        default = self._default(user, job_id)
        default.update(data)
        default["user"] = user
        default["job_id"] = job_id
        default["settings"] = {**self._default(user, job_id)["settings"], **data.get("settings", {})}
        return default

    def save(self, session: dict) -> dict:
        path = self.session_path(session["user"], session["job_id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        session = deepcopy(session)
        session["updated_at"] = _now()
        temporary = path.with_suffix(".tmp")
        with self._lock:
            temporary.write_text(json.dumps(session, indent=2), encoding="utf-8")
            os.replace(temporary, path)
        return session

    def update_chart(self, user: str, job_id: str, markers: list[dict], settings: dict) -> dict:
        session = self.get(user, job_id)
        session["markers"] = markers
        session["settings"] = {**session["settings"], **settings}
        return self.save(session)

    def create_take(self, user: str, job_id: str, suffix: str, metadata: dict) -> tuple[dict, Path]:
        take_id = uuid4().hex
        root = self.session_root(user, job_id)
        takes_root = root / "takes"
        takes_root.mkdir(parents=True, exist_ok=True)
        take = {
            "id": take_id,
            "name": metadata.get("name") or "New take",
            "notes": metadata.get("notes", ""),
            "duration": metadata.get("duration", 0),
            "mime_type": metadata.get("mime_type", "audio/webm"),
            "filename": f"{take_id}{suffix}",
            "midi_filename": f"{take_id}.midi.json" if metadata.get("midi_events") else None,
            "analysis": metadata.get("analysis"),
            "best": False,
            "created_at": _now(),
        }
        return take, takes_root / take["filename"]

    def save_midi(self, user: str, job_id: str, take: dict, events: list[dict]) -> None:
        filename = take.get("midi_filename")
        if not filename:
            return
        path = self.session_root(user, job_id) / "takes" / filename
        path.write_text(json.dumps(events, separators=(",", ":")), encoding="utf-8")

    def add_take(self, user: str, job_id: str, take: dict) -> dict:
        session = self.get(user, job_id)
        session["takes"].insert(0, take)
        return self.save(session)

    def update_take(self, user: str, job_id: str, take_id: str, updates: dict) -> dict:
        session = self.get(user, job_id)
        match = next((take for take in session["takes"] if take["id"] == take_id), None)
        if match is None:
            raise KeyError(take_id)
        if updates.get("best"):
            for take in session["takes"]:
                take["best"] = False
        match.update(updates)
        return self.save(session)

    def delete_take(self, user: str, job_id: str, take_id: str) -> dict:
        session = self.get(user, job_id)
        match = next((take for take in session["takes"] if take["id"] == take_id), None)
        if match is None:
            raise KeyError(take_id)
        path = self.session_root(user, job_id) / "takes" / match["filename"]
        if path.is_file():
            path.unlink()
        midi_filename = match.get("midi_filename")
        if midi_filename:
            midi_path = path.parent / midi_filename
            if midi_path.is_file():
                midi_path.unlink()
        session["takes"] = [take for take in session["takes"] if take["id"] != take_id]
        return self.save(session)

    def take_path(self, user: str, job_id: str, take_id: str) -> tuple[Path, dict]:
        session = self.get(user, job_id)
        take = next((item for item in session["takes"] if item["id"] == take_id), None)
        if take is None:
            raise KeyError(take_id)
        path = self.session_root(user, job_id) / "takes" / take["filename"]
        if not path.is_file():
            raise KeyError(take_id)
        return path, take

    def midi_events(self, user: str, job_id: str, take_id: str) -> tuple[list[dict], dict]:
        session = self.get(user, job_id)
        take = next((item for item in session["takes"] if item["id"] == take_id), None)
        if take is None or not take.get("midi_filename"):
            raise KeyError(take_id)
        path = self.session_root(user, job_id) / "takes" / take["midi_filename"]
        if not path.is_file():
            raise KeyError(take_id)
        return json.loads(path.read_text(encoding="utf-8")), take
