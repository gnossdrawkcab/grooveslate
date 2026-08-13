from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from threading import Lock
from urllib.parse import unquote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4
import ipaddress
import json
import os
import shutil
import socket
import subprocess

from .config import Settings
from .library import AUDIO_EXTENSIONS, MusicLibrary, Track


YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
CONTENT_TYPE_EXTENSIONS = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/m4a": ".m4a",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}


def _clean_title(value: str) -> str:
    cleaned = " ".join(value.replace("/", "-").replace("\\", "-").split())
    return cleaned[:180] or "Imported track"


def _validate_public_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Enter a valid http:// or https:// URL")
    if parsed.username or parsed.password:
        raise ValueError("URLs containing credentials are not accepted")
    try:
        default_port = 443 if parsed.scheme == "https" else 80
        addresses = socket.getaddrinfo(
            parsed.hostname,
            parsed.port or default_port,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise ValueError("The URL hostname could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("Private and local network URLs are not accepted")
    return value.strip()


class _SafeRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ImportService:
    def __init__(self, settings: Settings, library: MusicLibrary):
        self.settings = settings
        self.library = library
        self.root = settings.data_root / "imports"
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    @property
    def extractor_available(self) -> bool:
        return self.settings.media_extractor_enabled and shutil.which("yt-dlp") is not None

    @staticmethod
    def _is_youtube(url: str) -> bool:
        return (urlparse(url).hostname or "").casefold() in YOUTUBE_HOSTS

    def is_youtube_url(self, url: str) -> bool:
        return self._is_youtube(url)

    def capabilities(self) -> dict:
        return {
            "uploads": True,
            "direct_urls": True,
            "media_extractor": self.extractor_available,
            "max_import_bytes": self.settings.max_import_bytes,
            "max_duration_seconds": self.settings.max_import_duration_seconds,
        }

    def _existing(self, import_id: str) -> Track | None:
        manifest = self.root / import_id / "metadata.json"
        if not manifest.is_file():
            return None
        self.library.scan(force=True)
        try:
            return self.library.get(import_id)
        except KeyError:
            return None

    def _register(
        self,
        import_id: str,
        source: Path,
        *,
        title: str,
        source_type: str,
        source_label: str,
        provider: str,
        thumbnail_url: str = "",
    ) -> Track:
        destination_dir = self.root / import_id
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination = destination_dir / f"source{source.suffix.lower()}"
        if source.resolve() != destination.resolve():
            os.replace(source, destination)
        manifest = {
            "track_id": import_id,
            "filename": destination.name,
            "title": _clean_title(title),
            "source_type": source_type,
            "source_label": source_label,
            "provider": provider,
            "thumbnail_url": thumbnail_url if thumbnail_url.startswith("https://") else "",
        }
        temporary = destination_dir / "metadata.json.tmp"
        temporary.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        os.replace(temporary, destination_dir / "metadata.json")
        self.library.scan(force=True)
        return self.library.get(import_id)

    def import_upload(self, filename: str, stream, title: str = "") -> Track:
        suffix = Path(filename).suffix.casefold()
        if suffix not in AUDIO_EXTENSIONS:
            raise ValueError("Upload an MP3, FLAC, WAV, M4A, AAC, OGG, or Opus file")
        import_id = sha256(f"upload:{uuid4().hex}".encode()).hexdigest()[:24]
        destination_dir = self.root / import_id
        destination_dir.mkdir(parents=True, exist_ok=True)
        temporary = destination_dir / f"upload{suffix}.part"
        written = 0
        try:
            with temporary.open("wb") as output:
                while chunk := stream.read(1024 * 1024):
                    written += len(chunk)
                    if written > self.settings.max_import_bytes:
                        raise ValueError("The uploaded file exceeds the configured size limit")
                    output.write(chunk)
            if not written:
                raise ValueError("The uploaded file is empty")
            final = temporary.with_suffix("")
            os.replace(temporary, final)
            return self._register(
                import_id,
                final,
                title=title or Path(filename).stem,
                source_type="upload",
                source_label="Uploaded audio",
                provider="Uploads",
            )
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def import_url(self, url: str, *, title: str = "") -> Track:
        url = _validate_public_url(url)
        with self._lock:
            if self._is_youtube(url):
                if not self.extractor_available:
                    raise ValueError("YouTube importing is disabled on this server")
                return self._import_with_ytdlp(url)
            return self._import_direct(url, title=title)

    def _import_direct(self, url: str, *, title: str = "") -> Track:
        import_id = sha256(f"url:{url}".encode()).hexdigest()[:24]
        existing = self._existing(import_id)
        if existing:
            return existing
        request = Request(url, headers={"User-Agent": "GrooveSlate/2.0"})
        opener = build_opener(_SafeRedirects())
        destination_dir = self.root / import_id
        destination_dir.mkdir(parents=True, exist_ok=True)
        temporary = destination_dir / "download.part"
        try:
            with opener.open(request, timeout=120) as response:
                final_url = response.geturl()
                content_type = response.headers.get_content_type().casefold()
                suffix = Path(unquote(urlparse(final_url).path)).suffix.casefold()
                if suffix not in AUDIO_EXTENSIONS:
                    suffix = CONTENT_TYPE_EXTENSIONS.get(content_type, "")
                if suffix not in AUDIO_EXTENSIONS:
                    raise ValueError("The URL did not return a supported audio file")
                advertised = int(response.headers.get("Content-Length", "0") or 0)
                if advertised > self.settings.max_import_bytes:
                    raise ValueError("The remote file exceeds the configured size limit")
                written = 0
                with temporary.open("wb") as output:
                    while chunk := response.read(1024 * 1024):
                        written += len(chunk)
                        if written > self.settings.max_import_bytes:
                            raise ValueError("The remote file exceeds the configured size limit")
                        output.write(chunk)
            final = destination_dir / f"download{suffix}"
            os.replace(temporary, final)
            fallback_title = Path(unquote(urlparse(final_url).path)).stem
            return self._register(
                import_id,
                final,
                title=title or fallback_title,
                source_type="remote_url",
                source_label=urlparse(url).hostname or "Direct URL",
                provider="Direct URLs",
            )
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def _yt_dlp(self, arguments: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
        if not self.extractor_available:
            raise ValueError("The optional media extractor is disabled or unavailable")
        try:
            return subprocess.run(
                ["yt-dlp", "--ignore-config", *arguments],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=True,
            )
        except subprocess.TimeoutExpired as exc:
            raise ValueError("The media provider took too long to respond") from exc
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or exc.stdout or "Media extraction failed").strip().splitlines()[-1]
            if "403" in detail or "forbidden" in detail.casefold():
                raise ValueError(
                    "YouTube refused audio access for this video. Try another upload or version of the song."
                ) from exc
            raise ValueError(detail[-240:]) from exc

    def search(self, query: str, limit: int = 10) -> list[dict]:
        query = " ".join(query.split())[:200]
        if not query:
            return []
        result = self._yt_dlp(
            [
                "--flat-playlist",
                "--dump-single-json",
                "--playlist-end",
                str(min(20, max(1, limit))),
                f"ytsearch{min(20, max(1, limit))}:{query}",
            ]
        )
        data = json.loads(result.stdout)
        items = []
        for entry in data.get("entries") or []:
            video_id = str(entry.get("id") or "")
            duration = entry.get("duration")
            if not video_id or (duration and duration > self.settings.max_import_duration_seconds):
                continue
            items.append(
                {
                    "id": video_id,
                    "title": entry.get("title") or "Untitled video",
                    "channel": entry.get("channel") or entry.get("uploader") or "YouTube",
                    "duration": duration,
                    "url": f"https://www.youtube.com/watch?v={video_id}",
                    "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
                }
            )
        return items

    def _import_with_ytdlp(self, url: str) -> Track:
        info_result = self._yt_dlp(
            ["--no-playlist", "--skip-download", "--dump-single-json", "--ies", "youtube", url]
        )
        info = json.loads(info_result.stdout)
        video_id = str(info.get("id") or "")
        duration = info.get("duration")
        if not video_id:
            raise ValueError("No video was found at that URL")
        if duration and duration > self.settings.max_import_duration_seconds:
            raise ValueError("The video exceeds the configured duration limit")
        import_id = sha256(f"youtube:{video_id}".encode()).hexdigest()[:24]
        existing = self._existing(import_id)
        if existing:
            return existing
        destination_dir = self.root / import_id
        destination_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._yt_dlp(
                [
                    "--no-playlist",
                    "--ies",
                    "youtube",
                    "--max-filesize",
                    str(self.settings.max_import_bytes),
                    "--extract-audio",
                    "--audio-format",
                    "flac",
                    "--output",
                    str(destination_dir / "download.%(ext)s"),
                    url,
                ],
                timeout=min(self.settings.job_timeout_seconds, 1800),
            )
        except Exception:
            if not any(destination_dir.iterdir()):
                destination_dir.rmdir()
            raise
        candidates = [path for path in destination_dir.glob("download.*") if path.suffix != ".part"]
        if not candidates:
            raise ValueError("The extractor did not produce an audio file")
        source = max(candidates, key=lambda path: path.stat().st_size)
        if source.stat().st_size > self.settings.max_import_bytes:
            source.unlink(missing_ok=True)
            raise ValueError("The extracted audio exceeds the configured size limit")
        thumbnail = str(info.get("thumbnail") or "")
        return self._register(
            import_id,
            source,
            title=str(info.get("title") or "YouTube import"),
            source_type="media_extractor",
            source_label=str(info.get("channel") or info.get("uploader") or "YouTube"),
            provider="YouTube",
            thumbnail_url=thumbnail,
        )
