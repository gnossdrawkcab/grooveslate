from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from threading import Lock
from uuid import uuid4
import json
import os


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
            "best": False,
            "created_at": _now(),
        }
        return take, takes_root / take["filename"]

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
