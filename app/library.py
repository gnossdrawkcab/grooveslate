from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from threading import Lock, Thread
import json
import os
import sqlite3
import time
import unicodedata
from uuid import uuid4


AUDIO_EXTENSIONS = {
    ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".wv"
}


@dataclass(frozen=True)
class Track:
    id: str
    relative_path: str
    title: str
    folder: str
    extension: str
    size: int
    modified: int
    source_type: str = "library"
    source_label: str = "Music library"
    thumbnail_url: str = ""
    artist: str = ""
    album: str = ""

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "relative_path": self.relative_path,
            "title": self.title,
            "folder": self.folder,
            "extension": self.extension,
            "size": self.size,
            "modified": self.modified,
            "source_type": self.source_type,
            "source_label": self.source_label,
            "thumbnail_url": self.thumbnail_url,
            "artist": self.artist,
            "album": self.album,
        }


class MusicLibrary:
    def __init__(
        self,
        root: Path,
        max_tracks: int = 200_000,
        cache_seconds: int = 300,
        import_root: Path | None = None,
        index_path: Path | None = None,
        catalog_path: Path | None = None,
    ):
        self.root = root.resolve()
        self.import_root = import_root.resolve() if import_root else None
        self.max_tracks = max_tracks
        self.cache_seconds = cache_seconds
        self.index_path = index_path
        self.catalog_path = catalog_path
        self._tracks: list[Track] = []
        self._by_id: dict[str, Track] = {}
        self._paths: dict[str, Path] = {}
        self._searchable: dict[str, str] = {}
        self._scanned_at = 0.0
        self._lock = Lock()
        self._load_index()

    def _load_index(self) -> None:
        if not self.index_path or not self.index_path.is_file():
            return
        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
            if data.get("root") != str(self.root):
                return
            tracks = [Track(**item) for item in data.get("tracks", [])]
        except (OSError, TypeError, json.JSONDecodeError):
            return
        self._tracks = tracks
        self._by_id = {track.id: track for track in tracks}
        cached_paths = data.get("paths", {})
        self._paths = {
            track.id: Path(cached_paths.get(track.id, self.root / track.relative_path)).resolve()
            for track in tracks
        }
        self._rebuild_searchable()
        # Serve the warm index immediately, then let the normal cache interval
        # trigger a complete reconciliation with disk.
        self._scanned_at = time.monotonic()

    def _save_index(self) -> None:
        if not self.index_path:
            return
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.index_path.with_suffix(f".tmp-{uuid4().hex}")
        temporary.write_text(
            json.dumps(
                {
                    "root": str(self.root),
                    "tracks": [track.as_dict() for track in self._tracks],
                    "paths": {track_id: str(path) for track_id, path in self._paths.items()},
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        os.replace(temporary, self.index_path)

    @staticmethod
    def _id(relative_path: str) -> str:
        return sha256(relative_path.encode("utf-8")).hexdigest()[:24]

    @staticmethod
    def _search_text(value: str) -> str:
        decomposed = unicodedata.normalize("NFKD", value.casefold())
        return "".join(character for character in decomposed if not unicodedata.combining(character))

    def _rebuild_searchable(self) -> None:
        self._searchable = {
            track.id: self._search_text(
                f"{track.relative_path} {track.title} {track.artist} {track.album}"
            )
            for track in self._tracks
        }

    def scan(self, force: bool = False) -> list[Track]:
        with self._lock:
            if not force and self._tracks and time.monotonic() - self._scanned_at < self.cache_seconds:
                return self._tracks

            tracks: list[Track] = []
            paths: dict[str, Path] = {}
            if self.catalog_path and self.catalog_path.is_file():
                connection = sqlite3.connect(
                    f"file:{self.catalog_path}?mode=ro&immutable=1", uri=True
                )
                try:
                    rows = connection.execute(
                        "SELECT path, title, size, suffix, artist, album FROM media_file WHERE missing = 0 ORDER BY path COLLATE NOCASE"
                    )
                    for relative, title, size, suffix, artist, album in rows:
                        extension = f".{str(suffix).lower().lstrip('.')}"
                        if extension not in AUDIO_EXTENSIONS:
                            continue
                        relative_path = Path(relative)
                        if relative_path.is_absolute() or ".." in relative_path.parts:
                            continue
                        path = self.root / relative_path
                        track = Track(
                            id=self._id(relative),
                            relative_path=relative,
                            title=title or Path(relative).stem,
                            folder=Path(relative).parent.as_posix(),
                            extension=extension.lstrip("."),
                            size=int(size or 0),
                            modified=0,
                            artist=artist or "",
                            album=album or "",
                        )
                        tracks.append(track)
                        paths[track.id] = path
                        if self.max_tracks > 0 and len(tracks) >= self.max_tracks:
                            break
                finally:
                    connection.close()
            elif self.root.is_dir():
                for path in self.root.rglob("*"):
                    if self.max_tracks > 0 and len(tracks) >= self.max_tracks:
                        break
                    if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
                        continue
                    relative = path.relative_to(self.root).as_posix()
                    stat = path.stat()
                    track = Track(
                            id=self._id(relative),
                            relative_path=relative,
                            title=path.stem,
                            folder=path.parent.relative_to(self.root).as_posix(),
                            extension=path.suffix.lower().lstrip("."),
                            size=stat.st_size,
                            modified=int(stat.st_mtime),
                        )
                    tracks.append(track)
                    paths[track.id] = path.resolve()

            if self.import_root and self.import_root.is_dir():
                for manifest in self.import_root.glob("*/metadata.json"):
                    try:
                        metadata = json.loads(manifest.read_text(encoding="utf-8"))
                        source = (manifest.parent / metadata["filename"]).resolve()
                        if (
                            not source.is_relative_to(self.import_root)
                            or not source.is_file()
                            or source.suffix.lower() not in AUDIO_EXTENSIONS
                        ):
                            continue
                        stat = source.stat()
                        track = Track(
                            id=metadata["track_id"],
                            relative_path=f"Imports/{metadata['title']}{source.suffix}",
                            title=metadata["title"],
                            folder=f"Imports/{metadata.get('provider', 'Remote')}",
                            extension=source.suffix.lower().lstrip("."),
                            size=stat.st_size,
                            modified=int(stat.st_mtime),
                            source_type=metadata.get("source_type", "remote_url"),
                            source_label=metadata.get("source_label", "Imported audio"),
                            thumbnail_url=metadata.get("thumbnail_url", ""),
                        )
                    except (OSError, KeyError, TypeError, json.JSONDecodeError):
                        continue
                    tracks.append(track)
                    paths[track.id] = source

            tracks.sort(key=lambda item: item.relative_path.casefold())
            self._tracks = tracks
            self._by_id = {track.id: track for track in tracks}
            self._paths = paths
            self._rebuild_searchable()
            self._scanned_at = time.monotonic()
            # A six-figure library produces a large cache file. Persist it off
            # the request path so a catalog refresh never freezes search.
            Thread(target=self._save_index, daemon=True, name="library-index-save").start()
            return self._tracks

    def search(self, query: str = "", folder: str = "") -> list[Track]:
        tracks = self.scan()
        query_terms = self._search_text(query).split()
        normalized_folder = folder.strip().strip("/")
        return [
            track
            for track in tracks
            if all(term in self._searchable.get(track.id, "") for term in query_terms)
            and (
                not normalized_folder
                or track.folder == normalized_folder
                or track.folder.startswith(f"{normalized_folder}/")
            )
        ]

    def get(self, track_id: str) -> Track:
        self.scan()
        track = self._by_id.get(track_id)
        if track is None:
            raise KeyError(track_id)
        return track

    def path_for(self, track_id: str) -> Path:
        self.get(track_id)
        candidate = self._paths.get(track_id)
        allowed_roots = [self.root]
        if self.import_root:
            allowed_roots.append(self.import_root)
        if (
            candidate is None
            or not any(candidate.is_relative_to(root) for root in allowed_roots)
            or not candidate.is_file()
        ):
            raise KeyError(track_id)
        return candidate

    def folders(self) -> list[str]:
        folders = {track.folder for track in self.scan() if track.folder != "."}
        return sorted(folders, key=str.casefold)
