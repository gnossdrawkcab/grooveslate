from __future__ import annotations

from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import re
import secrets
import time
import unicodedata
from urllib.parse import parse_qs, quote

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Settings
from .challenges import (
    draw_challenge,
    draw_tracks,
    challenge_song_key,
    genre_options,
    is_original_song_result,
    youtube_challenge_hand,
    youtube_genre_options,
)
from .community import CommunityStore
from .jobs import JobQueue, JobStore, MODELS, Processor
from .imports import ImportService
from .library import MusicLibrary
from .practice import PracticeStore, analyze_midi, midi_file, sanitize_midi_events
from .songmap import SongMapper


class JobRequest(BaseModel):
    track_id: str


class MixRequest(BaseModel):
    excluded: list[str]


class PitchRequest(BaseModel):
    semitones: int = Field(ge=-12, le=12)
    excluded: list[str] = Field(default_factory=list)
    mix_id: str = Field(default="", max_length=24)


class URLImportRequest(BaseModel):
    url: str
    title: str = ""
    rights_confirmed: bool = False


class ChartMarker(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    time: float = Field(ge=0, le=86_400)
    label: str = Field(min_length=1, max_length=40)
    note: str = Field(default="", max_length=240)
    kind: str = Field(default="section", max_length=24)
    bar: int | None = Field(default=None, ge=1, le=100_000)
    bars: int | None = Field(default=None, ge=1, le=10_000)
    confidence: float | None = Field(default=None, ge=0, le=1)
    dynamics: str | None = Field(default=None, max_length=16)
    groove: str | None = Field(default=None, max_length=16)


class PracticeSettings(BaseModel):
    bpm: int = Field(default=120, ge=30, le=300)
    count_in_bars: int = Field(default=2, ge=0, le=4)
    metronome: bool = False
    backing_volume: float = Field(default=0.8, ge=0, le=1)


class PracticeUpdate(BaseModel):
    markers: list[ChartMarker] = Field(default_factory=list, max_length=300)
    settings: PracticeSettings = Field(default_factory=PracticeSettings)


class TakeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    notes: str | None = Field(default=None, max_length=500)
    best: bool | None = None


class ChallengeDraw(BaseModel):
    genre: str = Field(min_length=1, max_length=40)
    ready_only: bool = False
    exclude: list[str] = Field(default_factory=list, max_length=200)


class CommunityScore(BaseModel):
    score: int = Field(ge=1, le=5)


def slugify_title(title: str) -> str:
    normalized = unicodedata.normalize("NFKD", title)
    separated = re.sub(r"[^A-Za-z0-9]+", "-", normalized)
    return separated.casefold().strip("-")[:100] or "track"


def share_slug(track: dict) -> str:
    folder = track.get("folder", "")
    artist = track.get("artist", "") or (
        folder.split("/", 1)[0] if folder and folder != "." else ""
    )
    title = track.get("title", "track")
    numbered_title = re.search(
        r"\s+-\s+(?:\d{1,3}(?:-\d{1,3})?)\s+-\s+(.+)$",
        title,
    )
    song = numbered_title.group(1) if numbered_title else title
    return slugify_title(f"{artist} {song}".strip())


def create_app(
    settings: Settings | None = None,
    *,
    start_worker: bool = True,
) -> FastAPI:
    config = settings or Settings.from_env()
    config.data_root.mkdir(parents=True, exist_ok=True)
    library = MusicLibrary(
        config.music_root,
        config.max_scan_tracks,
        cache_seconds=config.library_cache_seconds,
        import_root=config.data_root / "imports",
        index_path=None if config.navidrome_db_path else config.data_root / "library-index.json",
        catalog_path=config.navidrome_db_path,
    )
    store = JobStore(config.data_root / "jobs")
    practice = PracticeStore(config.data_root / "practice")
    community = CommunityStore(config.data_root / "community")
    imports = ImportService(config, library)
    processor = Processor(config, library, store)
    song_mapper = SongMapper(config.data_root / "song-maps")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.queue = JobQueue(processor) if start_worker else None
        yield

    app = FastAPI(title="GrooveSlate", version="2.0.0", lifespan=lifespan)
    app.state.settings = config
    app.state.library = library
    app.state.store = store
    app.state.practice = practice
    app.state.community = community
    app.state.song_mapper = song_mapper
    app.state.imports = imports
    failed_logins: dict[str, list[float]] = {}
    public_requests: dict[tuple[str, str], list[float]] = {}
    if config.youtube_only and not config.session_secret:
        secret_path = config.data_root / "public-session-secret"
        if not secret_path.exists():
            secret_path.write_text(secrets.token_urlsafe(48))
            secret_path.chmod(0o600)
        session_secret = secret_path.read_text().strip()
    else:
        session_secret = config.session_secret or f"drumless:{config.app_password}"
    users = config.app_users or ("Pat", "Bob")
    users_by_key = {user.casefold(): user for user in users}
    admin_keys = {user.casefold() for user in config.app_admin_users}
    store.assign_unowned(users[0])

    def session_token(user: str) -> str:
        signature = hmac.new(
            session_secret.encode(),
            f"drumless-user-v2:{user}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return f"{user}:{signature}"

    def session_user(value: str) -> str | None:
        candidate, separator, _ = value.partition(":")
        user = users_by_key.get(candidate.casefold())
        if not separator or not user:
            return None
        return user if hmac.compare_digest(value, session_token(user)) else None

    def guest_token(user: str) -> str:
        signature = hmac.new(
            session_secret.encode(),
            f"grooveslate-guest-v1:{user}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return f"{user}:{signature}"

    def guest_user(value: str) -> str | None:
        user, separator, _ = value.partition(":")
        if not separator or not re.fullmatch(r"Guest-[a-f0-9]{8}", user):
            return None
        return user if hmac.compare_digest(value, guest_token(user)) else None

    def demo_token(job_id: str) -> str:
        signature = hmac.new(
            session_secret.encode(),
            f"grooveslate-demo-v1:{job_id}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return f"{job_id}:{signature}"

    def demo_job(value: str) -> dict | None:
        job_id, separator, _ = value.partition(":")
        if not separator or not hmac.compare_digest(value, demo_token(job_id)):
            return None
        try:
            job = store.get(job_id)
        except KeyError:
            return None
        return job if job.get("public_demo") is True else None

    def demo_from_song_path(path: str) -> dict | None:
        match = re.fullmatch(r"/songs/([^/]+)/?", path)
        if not match:
            return None
        for job in store.list(10000):
            if job.get("public_demo") is True and share_slug(job.get("track", {})) == match[1]:
                return job
        return None

    @app.middleware("http")
    async def password_gate(request: Request, call_next):
        if request.url.path in {"/login", "/api/health"}:
            return await call_next(request)
        if request.method == "GET" and request.url.path in {
            "/app.js", "/practice.js", "/styles.css", "/logo.svg",
            "/manifest.webmanifest", "/service-worker.js",
        }:
            return await call_next(request)
        linked_demo = demo_from_song_path(request.url.path)
        active_demo = linked_demo or demo_job(request.cookies.get("grooveslate_demo", ""))
        if active_demo:
            job_id = active_demo["id"]
            safe_demo_api = (
                request.url.path in {
                    "/api/session", "/api/completed", "/api/community",
                    "/api/imports/capabilities", f"/api/jobs/{job_id}",
                    f"/api/songs/{share_slug(active_demo.get('track', {}))}",
                }
                or request.url.path.startswith(f"/api/jobs/{job_id}/")
                or request.url.path.startswith(
                    f"/songs/{share_slug(active_demo.get('track', {}))}/"
                )
            )
            if linked_demo or safe_demo_api:
                request.state.user = "Demo"
                response = await call_next(request)
                if linked_demo:
                    response.set_cookie(
                        "grooveslate_demo", demo_token(job_id), max_age=60 * 60 * 24 * 30,
                        httponly=True,
                        secure=request.headers.get("x-forwarded-proto") == "https",
                        samesite="lax",
                    )
                return response
        if config.youtube_only:
            forwarded = request.headers.get("cf-connecting-ip") or request.headers.get(
                "x-forwarded-for", ""
            )
            client_ip = forwarded.split(",", 1)[0].strip() or (
                request.client.host if request.client else "unknown"
            )
            limits = {
                ("GET", "/api/imports/search"): (30, 600),
                ("POST", "/api/challenges/draw"): (30, 600),
                ("POST", "/api/imports/url"): (5, 3600),
                ("POST", "/api/jobs"): (3, 3600),
            }
            if limit := limits.get((request.method, request.url.path)):
                maximum, window = limit
                now = time.monotonic()
                key = (client_ip, f"{request.method}:{request.url.path}")
                recent = [
                    stamp
                    for stamp in public_requests.get(key, [])
                    if now - stamp < window
                ]
                if len(recent) >= maximum:
                    return JSONResponse(
                        {"detail": "Public usage limit reached. Please try again later."},
                        status_code=429,
                    )
                recent.append(now)
                public_requests[key] = recent
        if not config.app_password:
            if not config.youtube_only:
                request.state.user = users[0]
                return await call_next(request)
            guest = guest_user(request.cookies.get("grooveslate_guest", ""))
            if not guest:
                guest = f"Guest-{secrets.token_hex(4)}"
            request.state.user = guest
            response = await call_next(request)
            if request.cookies.get("grooveslate_guest") != guest_token(guest):
                response.set_cookie(
                    "grooveslate_guest",
                    guest_token(guest),
                    max_age=60 * 60 * 24 * 365,
                    httponly=True,
                    secure=request.headers.get("x-forwarded-proto") == "https",
                    samesite="lax",
                )
            return response
        authenticated = session_user(request.cookies.get("drumless_session", ""))
        if authenticated:
            request.state.user = authenticated
            return await call_next(request)
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "Authentication required"}, status_code=401)
        destination = quote(
            request.url.path
            + (f"?{request.url.query}" if request.url.query else ""),
            safe="/?=&",
        )
        return RedirectResponse(f"/login?next={destination}", status_code=303)

    def login_page(next_path: str, error: str = "") -> HTMLResponse:
        safe_next = html.escape(next_path, quote=True)
        error_markup = (
            f'<p class="error">{html.escape(error)}</p>' if error else ""
        )
        user_options = "".join(
            f'<option value="{html.escape(user, quote=True)}">{html.escape(user)}'
            f'{" — Admin" if user.casefold() in admin_keys else ""}</option>'
            for user in users
        )
        return HTMLResponse(
            f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GrooveSlate · Sign in</title>
<style>
:root{{--paper:#0d0c0b;--panel:#171512;--ink:#f3efe7;--orange:#f05a2a;--muted:#9a9389;--line:#37332e;color-scheme:dark}}
*{{box-sizing:border-box}} body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font-family:Arial,sans-serif}}
main{{width:min(420px,calc(100vw - 36px));border:1px solid var(--line);padding:34px;background:var(--panel);box-shadow:0 24px 80px rgba(0,0,0,.35)}}
.eyebrow{{color:var(--orange);font:10px monospace;letter-spacing:.13em}} h1{{margin:18px 0 8px;font-size:38px;letter-spacing:-.05em}}
p{{color:var(--muted);font-size:12px;line-height:1.5}} label{{display:block;margin:22px 0 8px;font:9px monospace;letter-spacing:.1em}}
input,select{{width:100%;height:48px;border:1px solid var(--line);background:var(--paper);color:var(--ink);padding:0 13px;font-size:16px}}
button{{width:100%;height:48px;margin-top:10px;border:0;background:var(--orange);color:white;font-weight:700;cursor:pointer}}
.error{{color:#a22b1f}}
</style></head><body><main><span class="eyebrow">YOUR DRUM PRACTICE ROOM</span><h1>GrooveSlate</h1>
<p>Choose your practice library and enter the shared password.</p>{error_markup}
<form method="post" action="/login"><input type="hidden" name="next" value="{safe_next}">
<label for="username">WHO IS PRACTICING?</label><select id="username" name="username" required>{user_options}</select>
<label for="password">WEB PASSWORD</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Enter →</button></form></main></body></html>"""
        )

    @app.get("/login")
    def login(request: Request):
        next_path = request.query_params.get("next", "/")
        if not next_path.startswith("/") or next_path.startswith("//"):
            next_path = "/"
        return login_page(next_path)

    @app.post("/login")
    async def submit_login(request: Request):
        values = parse_qs((await request.body()).decode("utf-8", errors="replace"))
        password = values.get("password", [""])[0]
        submitted_user = values.get("username", [""])[0]
        user = users_by_key.get(submitted_user.casefold())
        next_path = values.get("next", ["/"])[0]
        if not next_path.startswith("/") or next_path.startswith("//"):
            next_path = "/"
        forwarded = request.headers.get("x-forwarded-for", "")
        client_ip = forwarded.split(",", 1)[0].strip() or (
            request.client.host if request.client else "unknown"
        )
        now = time.monotonic()
        recent = [
            attempt
            for attempt in failed_logins.get(client_ip, [])
            if now - attempt < 300
        ]
        if len(recent) >= 10:
            failed_logins[client_ip] = recent
            return login_page(next_path, "Too many attempts. Try again in a few minutes.")
        if not user or not hmac.compare_digest(password, config.app_password):
            recent.append(now)
            failed_logins[client_ip] = recent
            return login_page(next_path, "Choose a valid user and enter the correct password.")
        failed_logins.pop(client_ip, None)
        response = RedirectResponse(next_path, status_code=303)
        response.set_cookie(
            "drumless_session",
            session_token(user),
            max_age=60 * 60 * 24 * 30,
            httponly=True,
            secure=request.headers.get("x-forwarded-proto") == "https",
            samesite="lax",
        )
        return response

    @app.get("/logout")
    def logout() -> RedirectResponse:
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie("drumless_session")
        return response

    @app.get("/api/session")
    def get_session(request: Request) -> dict:
        return {
            "user": request.state.user,
            "role": "admin" if request.state.user.casefold() in admin_keys else "member",
            "users": list(users),
            "source_mode": "youtube" if config.youtube_only else "library",
        }

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "library_available": config.music_root.is_dir(),
            "models": {
                "scnet": config.scnet_enabled,
                "roformer": config.bs_roformer_enabled,
            },
            "imports": imports.capabilities(),
        }

    @app.get("/api/imports/capabilities")
    def import_capabilities() -> dict:
        return {**imports.capabilities(), "youtube_only": config.youtube_only}

    @app.get("/api/imports/search")
    def search_imports(
        q: str = Query(min_length=1, max_length=200),
        limit: int = Query(default=10, ge=1, le=20),
    ) -> dict:
        try:
            results = imports.search(q, limit)
        except (ValueError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"results": results}

    @app.post("/api/imports/url", status_code=201)
    def import_url(payload: URLImportRequest) -> dict:
        if config.youtube_only and not payload.rights_confirmed:
            raise HTTPException(status_code=400, detail="Confirm that you own or have permission to use this media.")
        try:
            track = imports.import_url(
                payload.url,
                title=payload.title,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except OSError:
            raise HTTPException(status_code=502, detail="The remote audio could not be imported") from None
        return {"track": track.as_dict()}

    @app.post("/api/imports/upload", status_code=201)
    async def import_upload(
        request: Request,
        file: UploadFile = File(...),
        title: str = Form(default=""),
        artist: str = Form(default=""),
    ) -> dict:
        if config.youtube_only and request.state.user.casefold() not in admin_keys:
            await file.close()
            raise HTTPException(status_code=404, detail="Uploads are unavailable on this site")
        try:
            track = imports.import_upload(file.filename or "upload", file.file, title, artist)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        finally:
            await file.close()
        return {"track": track.as_dict()}

    @app.get("/api/library")
    def get_library(
        q: str = Query(default="", max_length=200),
        folder: str = Query(default="", max_length=500),
        limit: int = Query(default=250, ge=1, le=1000),
        refresh: bool = False,
    ) -> dict:
        if config.youtube_only:
            raise HTTPException(status_code=404, detail="The server library is unavailable on this site")
        if refresh:
            library.scan(force=True)
        tracks = library.search(q, folder)
        return {
            "tracks": [track.as_dict() for track in tracks[:limit]],
            "total": len(tracks),
            "folders": library.folders(),
            "root_name": config.music_root.name,
        }

    @app.get("/api/tracks/{track_id}/stream")
    def stream_track(track_id: str):
        try:
            path = library.path_for(track_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Track not found") from None
        return FileResponse(path)

    def visible_to(job: dict, user: str) -> bool:
        return job.get("user") == user or job.get("public_demo") is True

    def owned_job(job_id: str, user: str) -> dict:
        job = store.get(job_id)
        if not visible_to(job, user):
            raise KeyError(job_id)
        return job

    def completed_jobs(user: str) -> dict[str, dict]:
        completed: dict[str, dict] = {}
        for job in store.list(10000):
            track_id = job.get("track", {}).get("id")
            if (
                visible_to(job, user)
                and job.get("status") == "complete"
                and track_id
                and any(job.get("models", {}).get(model, {}).get("status") == "complete" for model in ("roformer", "scnet"))
            ):
                completed.setdefault(track_id, job)
        return completed

    @app.get("/api/challenges/genres")
    def get_challenge_genres(request: Request) -> dict:
        if config.youtube_only:
            options = youtube_genre_options()
            return {"genres": options, "ready_genres": [], "tagged_tracks": None, "source": "youtube"}
        tracks = library.scan()
        ready_ids = set(completed_jobs(request.state.user))
        return {
            "genres": genre_options(tracks),
            "ready_genres": genre_options(tracks, ready_ids),
            "tagged_tracks": sum(bool(track.genres) for track in tracks),
        }

    @app.post("/api/challenges/draw")
    def draw_song_challenge(payload: ChallengeDraw, request: Request) -> dict:
        if config.youtube_only:
            if payload.ready_only:
                raise HTTPException(status_code=400, detail="Ready-only draws are unavailable in YouTube mode")
            try:
                hand = youtube_challenge_hand(payload.genre, set(payload.exclude))
                options = []
                seen = {value[:140] for value in payload.exclude}
                seen_videos = set()
                with ThreadPoolExecutor(max_workers=5) as executor:
                    result_sets = list(executor.map(
                        lambda seed: imports.search(seed["query"], 8), hand
                    ))
                for seed, search_results in zip(hand, result_sets):
                    key = challenge_song_key({"title": seed["query"]})
                    selected = None
                    for candidate in search_results:
                        video_key = candidate.get("id", candidate["url"])
                        if is_original_song_result(candidate) and video_key not in seen_videos:
                            selected = candidate
                            break
                    if selected and key not in seen:
                        video_key = selected.get("id", selected["url"])
                        seen.add(key)
                        seen_videos.add(video_key)
                        options.append({
                            "track": {"id": video_key, "title": selected["title"], "artist": selected.get("channel", "YouTube"), "album": "YouTube challenge", "duration": selected.get("duration")},
                            "youtube_url": selected["url"], "ready_job_id": None,
                            "selection_lane": seed["lane"], "studio_only": True,
                            "shuffle_key": key,
                        })
            except KeyError:
                raise HTTPException(status_code=400, detail="Choose a supported genre") from None
            except (ValueError, json.JSONDecodeError) as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from None
            if not options:
                raise HTTPException(
                    status_code=404,
                    detail="YouTube returned no original-song results for that genre. Draw again.",
                )
            return {
                "challenge": draw_challenge(),
                "options": options,
                **options[0],
            }
        tracks = library.scan()
        ready = completed_jobs(request.state.user)
        try:
            drawn_tracks = draw_tracks(
                tracks, payload.genre, set(ready) if payload.ready_only else None,
                excluded_ids=set(payload.exclude),
            )
        except KeyError:
            raise HTTPException(status_code=400, detail="Choose a supported genre") from None
        except LookupError:
            if payload.exclude:
                drawn_tracks = draw_tracks(
                    tracks, payload.genre,
                    set(ready) if payload.ready_only else None,
                )
            else:
                raise HTTPException(status_code=404, detail="No eligible songs in that genre") from None
        options = []
        for track in drawn_tracks:
            job = ready.get(track.id)
            options.append({"track": track.as_dict(), "ready_job_id": job["id"] if job else None, "shuffle_key": track.id})
        return {"options": options, "challenge": draw_challenge(), **options[0]}

    def practice_response(user: str, job_id: str, session: dict | None = None) -> dict:
        data = session or practice.get(user, job_id)
        publications = {
            item["take_id"]: item for item in community.list(user)
            if item["owned"] and item["job_id"] == job_id
        }
        data["takes"] = [
            {
                **take,
                "audio_url": f"/api/jobs/{job_id}/practice/takes/{take['id']}/audio",
                "download_url": f"/api/jobs/{job_id}/practice/takes/{take['id']}/audio?download=true",
                "midi_url": (f"/api/jobs/{job_id}/practice/takes/{take['id']}/midi"
                             if take.get("midi_filename") else None),
                "events_url": (f"/api/jobs/{job_id}/practice/takes/{take['id']}/events"
                               if take.get("midi_filename") else None),
                "publication": publications.get(take["id"]),
            }
            for take in data.get("takes", [])
        ]
        return data

    @app.get("/api/community")
    def list_community_takes(request: Request) -> dict:
        items = community.list(request.state.user)
        return {
            "takes": [
                {**item, "audio_url": f"/api/community/{item['id']}/audio"}
                for item in items
            ]
        }

    @app.post("/api/jobs/{job_id}/practice/takes/{take_id}/publish", status_code=201)
    def publish_practice_take(job_id: str, take_id: str, request: Request) -> dict:
        try:
            job = owned_job(job_id, request.state.user)
            _, take = practice.take_path(request.state.user, job_id, take_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Take not found") from None
        publication = community.publish(request.state.user, job, take)
        return {**publication, "audio_url": f"/api/community/{publication['id']}/audio"}

    @app.delete("/api/community/{publication_id}")
    def unpublish_practice_take(publication_id: str, request: Request) -> dict:
        try:
            community.unpublish(request.state.user, publication_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Published take not found") from None
        return {"deleted": True}

    @app.put("/api/community/{publication_id}/score")
    def score_community_take(publication_id: str, payload: CommunityScore, request: Request) -> dict:
        try:
            return community.score(request.state.user, publication_id, payload.score)
        except KeyError:
            raise HTTPException(status_code=404, detail="Published take not found") from None
        except PermissionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @app.get("/api/community/{publication_id}/audio")
    def stream_community_take(publication_id: str):
        try:
            publication = community.get(publication_id)
            path, take = practice.take_path(publication["owner"], publication["job_id"], publication["take_id"])
        except KeyError:
            raise HTTPException(status_code=404, detail="Published take unavailable") from None
        return FileResponse(path, media_type=take["mime_type"])

    @app.get("/api/jobs")
    def list_jobs(request: Request, limit: int = Query(default=12, ge=1, le=50)) -> dict:
        jobs = [job for job in store.list(10000) if visible_to(job, request.state.user)]
        return {"jobs": jobs[:limit]}

    def job_for_song(slug: str, user: str) -> dict:
        for job in store.list(10000):
            if visible_to(job, user) and share_slug(job.get("track", {})) == slug:
                return job
        raise KeyError(slug)

    @app.get("/api/completed")
    def list_completed(request: Request, limit: int = Query(default=250, ge=1, le=500)) -> dict:
        completed = []
        seen_tracks: set[str] = set()
        for job in store.list(10000):
            if not visible_to(job, request.state.user):
                continue
            track_id = job.get("track", {}).get("id")
            if job.get("status") != "complete" or not track_id or track_id in seen_tracks:
                continue
            seen_tracks.add(track_id)
            playable_model = next(
                (
                    model
                    for model in ("roformer", "scnet")
                    if job.get("models", {}).get(model, {}).get("status") == "complete"
                ),
                None,
            )
            if not playable_model:
                continue
            practice_session = practice.get(request.state.user, job["id"])
            completed.append(
                {
                    "job_id": job["id"],
                    "track": job["track"],
                    "completed_at": job["updated_at"],
                    "share_url": f"/songs/{share_slug(job['track'])}",
                    "audio_url": f"/api/jobs/{job['id']}/audio/{playable_model}",
                    "model": playable_model,
                    "user": job["user"],
                    "practice": {
                        "marker_count": len(practice_session.get("markers", [])),
                        "take_count": len(practice_session.get("takes", [])),
                        "has_best_take": any(
                            take.get("best") for take in practice_session.get("takes", [])
                        ),
                    },
                }
            )
            if len(completed) >= limit:
                break
        return {"completed": completed, "total": len(completed)}

    @app.post("/api/jobs", status_code=202)
    def create_job(payload: JobRequest, request: Request) -> dict:
        try:
            track = library.get(payload.track_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Track not found") from None
        job = store.create(track, request.state.user)
        queue = request.app.state.queue
        if queue is not None:
            queue.submit(job["id"])
        return job

    @app.post("/api/jobs/{job_id}/public-demo")
    def publish_demo(job_id: str, request: Request) -> dict:
        if request.state.user.casefold() not in admin_keys:
            raise HTTPException(status_code=403, detail="Admin access required")
        try:
            owned_job(job_id, request.state.user)
            return store.update(job_id, lambda job: job.update(public_demo=True))
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str, request: Request) -> dict:
        try:
            return owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None

    @app.get("/api/jobs/{job_id}/practice")
    def get_practice(job_id: str, request: Request) -> dict:
        try:
            owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        return practice_response(request.state.user, job_id)

    @app.put("/api/jobs/{job_id}/practice")
    def update_practice(job_id: str, payload: PracticeUpdate, request: Request) -> dict:
        try:
            owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        markers = sorted(
            (marker.model_dump() for marker in payload.markers),
            key=lambda marker: marker["time"],
        )
        session = practice.update_chart(
            request.state.user,
            job_id,
            markers,
            payload.settings.model_dump(),
        )
        return practice_response(request.state.user, job_id, session)

    @app.post("/api/jobs/{job_id}/practice/auto-map")
    def auto_map_practice(job_id: str, request: Request) -> dict:
        try:
            job = owned_job(job_id, request.state.user)
            prepared = store.root / job_id / "input" / "source.wav"
            source = prepared if prepared.is_file() else library.path_for(job["track"]["id"])
            analysis = song_mapper.analyze(source)
        except KeyError:
            raise HTTPException(status_code=404, detail="Song not found") from None
        except (ValueError, RuntimeError, OSError) as exc:
            raise HTTPException(status_code=422, detail=f"Automatic chart unavailable: {exc}") from None
        session = practice.get(request.state.user, job_id)
        session["markers"] = analysis["markers"]
        session["settings"]["bpm"] = analysis["bpm"]
        session["auto_map"] = {
            key: value for key, value in analysis.items() if key != "markers"
        }
        session = practice.save(session)
        return practice_response(request.state.user, job_id, session)

    @app.post("/api/jobs/{job_id}/practice/takes", status_code=201)
    async def create_practice_take(
        job_id: str,
        request: Request,
        file: UploadFile = File(...),
        name: str = Form(default=""),
        notes: str = Form(default=""),
        duration: float = Form(default=0),
        midi_events: str = Form(default="[]"),
    ) -> dict:
        try:
            owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        mime_type = (file.content_type or "").split(";", 1)[0].casefold()
        suffixes = {
            "audio/webm": ".webm",
            "video/webm": ".webm",
            "audio/mp4": ".m4a",
            "video/mp4": ".mp4",
            "audio/ogg": ".ogg",
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/mpeg": ".mp3",
            "audio/flac": ".flac",
            "audio/aac": ".aac",
        }
        suffix = suffixes.get(mime_type)
        if suffix is None:
            raise HTTPException(status_code=400, detail="This recording format is not supported")
        try:
            events = sanitize_midi_events(json.loads(midi_events))
        except (ValueError, TypeError, json.JSONDecodeError):
            raise HTTPException(status_code=400, detail="MIDI capture is not valid") from None
        take_duration = max(0, min(float(duration), 86_400))
        session = practice.get(request.state.user, job_id)
        analysis = analyze_midi(
            events,
            int(session["settings"].get("bpm", 120)),
            session.get("markers", []),
            take_duration,
        ) if events else None
        take, destination = practice.create_take(
            request.state.user,
            job_id,
            suffix,
            {
                "name": name.strip()[:80],
                "notes": notes.strip()[:500],
                "duration": take_duration,
                "mime_type": mime_type,
                "midi_events": events,
                "analysis": analysis,
            },
        )
        temporary = destination.with_suffix(f"{destination.suffix}.part")
        size = 0
        try:
            with temporary.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > 250 * 1024 * 1024:
                        raise HTTPException(status_code=413, detail="Recording exceeds the 250 MB limit")
                    output.write(chunk)
            if size < 256:
                raise HTTPException(status_code=400, detail="The recording is empty")
            os.replace(temporary, destination)
            practice.save_midi(request.state.user, job_id, take, events)
        finally:
            await file.close()
            if temporary.is_file():
                temporary.unlink()
        session = practice.add_take(request.state.user, job_id, take)
        return practice_response(request.state.user, job_id, session)

    @app.patch("/api/jobs/{job_id}/practice/takes/{take_id}")
    def update_practice_take(
        job_id: str, take_id: str, payload: TakeUpdate, request: Request
    ) -> dict:
        try:
            owned_job(job_id, request.state.user)
            updates = payload.model_dump(exclude_none=True)
            session = practice.update_take(request.state.user, job_id, take_id, updates)
        except KeyError:
            raise HTTPException(status_code=404, detail="Take not found") from None
        return practice_response(request.state.user, job_id, session)

    @app.delete("/api/jobs/{job_id}/practice/takes/{take_id}")
    def delete_practice_take(job_id: str, take_id: str, request: Request) -> dict:
        try:
            owned_job(job_id, request.state.user)
            community.remove_take(request.state.user, job_id, take_id)
            session = practice.delete_take(request.state.user, job_id, take_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Take not found") from None
        return practice_response(request.state.user, job_id, session)

    @app.get("/api/jobs/{job_id}/practice/takes/{take_id}/audio")
    def stream_practice_take(
        job_id: str, take_id: str, request: Request, download: bool = False
    ):
        try:
            job = owned_job(job_id, request.state.user)
            path, take = practice.take_path(request.state.user, job_id, take_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Take not found") from None
        if not download:
            return FileResponse(path, media_type=take["mime_type"])
        safe_title = re.sub(r"[^A-Za-z0-9 ._-]+", "_", job["track"]["title"]).strip()
        safe_take = re.sub(r"[^A-Za-z0-9 ._-]+", "_", take["name"]).strip()
        return FileResponse(
            path,
            media_type=take["mime_type"],
            filename=f"{safe_title} - {safe_take}{path.suffix}",
        )

    @app.get("/api/jobs/{job_id}/practice/takes/{take_id}/events")
    def get_practice_take_events(job_id: str, take_id: str, request: Request) -> dict:
        try:
            owned_job(job_id, request.state.user)
            events, take = practice.midi_events(request.state.user, job_id, take_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="MIDI performance not found") from None
        return {"take_id": take_id, "events": events, "analysis": take.get("analysis")}

    @app.get("/api/jobs/{job_id}/practice/takes/{take_id}/midi")
    def download_practice_take_midi(job_id: str, take_id: str, request: Request):
        try:
            job = owned_job(job_id, request.state.user)
            events, take = practice.midi_events(request.state.user, job_id, take_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="MIDI performance not found") from None
        bpm = int((take.get("analysis") or {}).get("bpm", 120))
        safe_title = re.sub(r"[^A-Za-z0-9 ._-]+", "_", job["track"]["title"]).strip()
        safe_take = re.sub(r"[^A-Za-z0-9 ._-]+", "_", take["name"]).strip()
        return Response(
            midi_file(events, bpm),
            media_type="audio/midi",
            headers={"Content-Disposition": f'attachment; filename="{safe_title} - {safe_take}.mid"'},
        )

    @app.get("/api/songs/{slug}")
    def get_song_job(slug: str, request: Request) -> dict:
        try:
            return job_for_song(slug, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Song not found") from None

    def result_file(job_id: str, model: str, user: str) -> tuple[Path, dict]:
        if model not in MODELS:
            raise HTTPException(status_code=404, detail="Model not found")
        try:
            job = owned_job(job_id, user)
            path = store.output_path(job_id, model)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        if not path.is_file() or job["models"][model]["status"] != "complete":
            raise HTTPException(status_code=404, detail="Result is not ready")
        return path, job

    @app.get("/api/jobs/{job_id}/audio/{model}")
    def stream_result(job_id: str, model: str, request: Request):
        path, _ = result_file(job_id, model, request.state.user)
        return FileResponse(path, media_type="audio/flac")

    @app.get("/api/jobs/{job_id}/download/{model}")
    def download_result(job_id: str, model: str, request: Request):
        path, job = result_file(job_id, model, request.state.user)
        path = processor.render_mp3(path)
        safe_title = "".join(
            character if character.isalnum() or character in " -_." else "_"
            for character in job["track"]["title"]
        ).strip()
        return FileResponse(
            path,
            media_type="audio/mpeg",
            filename=f"{safe_title} - {MODELS[model]['name']} - no drums.mp3",
        )

    @app.get("/api/jobs/{job_id}/waveform/{model}")
    def get_result_waveform(
        job_id: str,
        model: str,
        request: Request,
        points: int = Query(default=1600, ge=400, le=2400),
        exclude: str = Query(default="", max_length=200),
        mix_id: str = Query(default="", max_length=24),
    ) -> dict:
        result_file(job_id, model, request.state.user)
        try:
            excluded = [name for name in exclude.split(",") if name]
            selected_mix_id = mix_id
            if selected_mix_id and not selected_mix_id.isalnum():
                raise ValueError("Invalid mix identifier")
            if excluded and not selected_mix_id:
                _, selected_mix_id = processor.render_stem_mix(job_id, model, excluded)
            return processor.waveform(job_id, model, points, selected_mix_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except (KeyError, RuntimeError) as exc:
            raise HTTPException(status_code=500, detail=f"Waveform unavailable: {exc}") from None

    @app.get("/songs/{slug}/audio/{model}")
    def stream_named_result(slug: str, model: str, request: Request):
        try:
            job = job_for_song(slug, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Song not found") from None
        path, _ = result_file(job["id"], model, request.state.user)
        path = processor.render_mp3(path)
        return FileResponse(path, media_type="audio/flac")

    @app.get("/songs/{slug}/download/{model}")
    def download_named_result(slug: str, model: str, request: Request):
        try:
            job = job_for_song(slug, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Song not found") from None
        path, _ = result_file(job["id"], model, request.state.user)
        safe_title = "".join(
            character if character.isalnum() or character in " -_." else "_"
            for character in job["track"]["title"]
        ).strip()
        return FileResponse(
            path,
            media_type="audio/mpeg",
            filename=f"{safe_title} - {MODELS[model]['name']} - no drums.mp3",
        )

    @app.get("/api/jobs/{job_id}/stems/{model}")
    def list_result_stems(job_id: str, model: str, request: Request) -> dict:
        if model not in MODELS:
            raise HTTPException(status_code=404, detail="Model not found")
        try:
            job = owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        if job["models"][model]["status"] != "complete":
            raise HTTPException(status_code=409, detail="Model is not complete")
        stems = processor.list_stems(store.root / job_id, model)
        return {
            "stems": [
                {
                    "name": name,
                    "audio_url": f"/api/jobs/{job_id}/stem/{model}/{name}",
                }
                for name in sorted(stems)
            ]
        }

    @app.get("/api/jobs/{job_id}/stem/{model}/{stem}")
    def stream_stem(job_id: str, model: str, stem: str, request: Request):
        if model not in MODELS:
            raise HTTPException(status_code=404, detail="Model not found")
        try:
            owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        stems = processor.list_stems(store.root / job_id, model)
        path = stems.get(stem)
        if path is None:
            raise HTTPException(status_code=404, detail="Stem not found")
        return FileResponse(path)

    @app.post("/api/jobs/{job_id}/mix/{model}")
    def render_mix(job_id: str, model: str, payload: MixRequest, request: Request) -> dict:
        try:
            job = owned_job(job_id, request.state.user)
            if job["models"][model]["status"] != "complete":
                raise HTTPException(status_code=409, detail="Model is not complete")
            _, mix_id = processor.render_stem_mix(job_id, model, payload.excluded)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job or model not found") from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        slug = share_slug(job["track"])
        excluded_query = ",".join(sorted(set(payload.excluded)))
        query = f"?exclude={excluded_query}" if excluded_query else ""
        download_query = f"{query}{'&' if query else '?'}download=true"
        return {
            "mix_id": mix_id,
            "excluded": sorted(set(payload.excluded)),
            "audio_url": f"/songs/{slug}/mix/{model}{query}",
            "download_url": f"/songs/{slug}/mix/{model}{download_query}",
        }

    @app.get("/api/jobs/{job_id}/mix/{model}/{mix_id}")
    def stream_mix(
        job_id: str, model: str, mix_id: str, request: Request, download: bool = False
    ):
        if model not in MODELS or not mix_id.isalnum():
            raise HTTPException(status_code=404, detail="Mix not found")
        try:
            job = owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        path = store.root / job_id / model / "mixes" / f"{mix_id}.flac"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Mix not found")
        if not download:
            return FileResponse(path, media_type="audio/flac")
        path = processor.render_mp3(path)
        safe_title = "".join(
            character if character.isalnum() or character in " -_." else "_"
            for character in job["track"]["title"]
        ).strip()
        return FileResponse(
            path,
            media_type="audio/mpeg",
            filename=f"{safe_title} - {MODELS[model]['name']} - custom mix.mp3",
        )

    @app.post("/api/jobs/{job_id}/pitch/{model}")
    def render_pitch(
        job_id: str, model: str, payload: PitchRequest, request: Request
    ) -> dict:
        try:
            job = owned_job(job_id, request.state.user)
            if model not in MODELS or job["models"][model]["status"] != "complete":
                raise HTTPException(status_code=409, detail="Model is not complete")
            if payload.mix_id:
                if not payload.mix_id.isalnum():
                    raise ValueError("Invalid mix identifier")
                source = store.root / job_id / model / "mixes" / f"{payload.mix_id}.flac"
                if not source.is_file():
                    raise KeyError(payload.mix_id)
            elif payload.excluded:
                source, _ = processor.render_stem_mix(job_id, model, payload.excluded)
            else:
                source = store.output_path(job_id, model)
            _, variant_id = processor.render_pitch_variant(
                job_id, model, source, payload.semitones
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="Job, mix, or model not found") from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {
            "variant_id": variant_id,
            "semitones": payload.semitones,
            "audio_url": f"/api/jobs/{job_id}/pitch/{model}/{variant_id}",
        }

    @app.get("/api/jobs/{job_id}/pitch/{model}/{variant_id}")
    def stream_pitch(
        job_id: str, model: str, variant_id: str, request: Request
    ):
        if model not in MODELS or not variant_id.isalnum():
            raise HTTPException(status_code=404, detail="Pitch variant not found")
        try:
            owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        path = store.root / job_id / model / "pitches" / f"{variant_id}.flac"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Pitch variant not found")
        return FileResponse(path, media_type="audio/flac")

    @app.get("/songs/{slug}/mix/{model}")
    def stream_named_mix(
        slug: str,
        model: str,
        request: Request,
        exclude: str = "",
        download: bool = False,
    ):
        try:
            job = job_for_song(slug, request.state.user)
            if job["models"][model]["status"] != "complete":
                raise HTTPException(status_code=409, detail="Model is not complete")
            excluded = [name for name in exclude.split(",") if name]
            path, _ = processor.render_stem_mix(job["id"], model, excluded)
        except KeyError:
            raise HTTPException(status_code=404, detail="Song or model not found") from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        if not download:
            return FileResponse(path, media_type="audio/flac")
        path = processor.render_mp3(path)
        safe_title = "".join(
            character if character.isalnum() or character in " -_." else "_"
            for character in job["track"]["title"]
        ).strip()
        return FileResponse(
            path,
            media_type="audio/mpeg",
            filename=f"{safe_title} - {MODELS[model]['name']} - custom mix.mp3",
        )

    static_root = Path(__file__).parent / "static"

    @app.get("/jobs/{job_id}")
    def job_page(job_id: str, request: Request):
        try:
            job = owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        return RedirectResponse(f"/songs/{share_slug(job['track'])}", status_code=307)

    @app.get("/jobs/{job_id}/{slug}")
    def named_job_page(job_id: str, slug: str, request: Request):
        try:
            job = owned_job(job_id, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Job not found") from None
        return RedirectResponse(f"/songs/{share_slug(job['track'])}", status_code=307)

    @app.get("/songs/{slug}")
    def song_page(slug: str, request: Request):
        try:
            job_for_song(slug, request.state.user)
        except KeyError:
            raise HTTPException(status_code=404, detail="Song not found") from None
        return FileResponse(static_root / "index.html", media_type="text/html")

    app.mount("/", StaticFiles(directory=static_root, html=True), name="static")
    return app


app = create_app()
