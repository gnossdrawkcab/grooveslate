from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from uuid import uuid4
import json
import os


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class CommunityStore:
    """Opt-in take publishing and one-score-per-user community ratings."""

    def __init__(self, root: Path):
        self.path = root / "community.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def _read(self) -> dict:
        if not self.path.is_file():
            return {"publications": []}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data.get("publications"), list) else {"publications": []}
        except (OSError, json.JSONDecodeError, AttributeError):
            return {"publications": []}

    def _write(self, data: dict) -> None:
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(temporary, self.path)

    @staticmethod
    def _present(item: dict, viewer: str) -> dict:
        scores = list(item.get("scores", {}).values())
        return {
            key: deepcopy(value) for key, value in item.items() if key != "scores"
        } | {
            "score": round(sum(scores) / len(scores), 1) if scores else None,
            "score_count": len(scores),
            "your_score": item.get("scores", {}).get(viewer.casefold()),
            "owned": item["owner"].casefold() == viewer.casefold(),
        }

    def list(self, viewer: str) -> list[dict]:
        with self._lock:
            items = self._read()["publications"]
        return [self._present(item, viewer) for item in reversed(items)]

    def publish(self, owner: str, job: dict, take: dict) -> dict:
        with self._lock:
            data = self._read()
            existing = next((item for item in data["publications"] if item["owner"].casefold() == owner.casefold() and item["job_id"] == job["id"] and item["take_id"] == take["id"]), None)
            if existing is None:
                existing = {
                    "id": uuid4().hex,
                    "owner": owner,
                    "job_id": job["id"],
                    "take_id": take["id"],
                    "song_title": job["track"].get("title", "Unknown song"),
                    "song_artist": job["track"].get("artist") or job["track"].get("folder", "").split("/", 1)[0],
                    "take_name": take.get("name", "Take"),
                    "notes": take.get("notes", ""),
                    "duration": take.get("duration", 0),
                    "mime_type": take.get("mime_type", "audio/webm"),
                    "analysis": take.get("analysis"),
                    "published_at": _now(),
                    "scores": {},
                }
                data["publications"].append(existing)
                self._write(data)
        return self._present(existing, owner)

    def get(self, publication_id: str) -> dict:
        with self._lock:
            item = next((item for item in self._read()["publications"] if item["id"] == publication_id), None)
        if item is None:
            raise KeyError(publication_id)
        return item

    def unpublish(self, owner: str, publication_id: str) -> None:
        with self._lock:
            data = self._read()
            item = next((item for item in data["publications"] if item["id"] == publication_id), None)
            if item is None or item["owner"].casefold() != owner.casefold():
                raise KeyError(publication_id)
            data["publications"] = [entry for entry in data["publications"] if entry["id"] != publication_id]
            self._write(data)

    def remove_take(self, owner: str, job_id: str, take_id: str) -> None:
        with self._lock:
            data = self._read()
            data["publications"] = [
                item for item in data["publications"]
                if not (item["owner"].casefold() == owner.casefold() and item["job_id"] == job_id and item["take_id"] == take_id)
            ]
            self._write(data)

    def score(self, viewer: str, publication_id: str, score: int) -> dict:
        with self._lock:
            data = self._read()
            item = next((item for item in data["publications"] if item["id"] == publication_id), None)
            if item is None:
                raise KeyError(publication_id)
            if item["owner"].casefold() == viewer.casefold():
                raise PermissionError("You cannot score your own take")
            item.setdefault("scores", {})[viewer.casefold()] = score
            self._write(data)
        return self._present(item, viewer)
