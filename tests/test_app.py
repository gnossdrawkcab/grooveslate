from pathlib import Path
from array import array
from dataclasses import replace
from io import BytesIO
import shutil
import sqlite3
import subprocess
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.challenges import (
    draw_track,
    genre_options,
    is_original_song_result,
    track_genres,
    youtube_challenge_query,
)
from app.jobs import JobQueue, JobStore, Processor
from app.imports import ImportService
from app.library import MusicLibrary, Track
from app.main import create_app, share_slug, slugify_title


def settings(tmp_path: Path) -> Settings:
    music = tmp_path / "music"
    music.mkdir()
    data = tmp_path / "data"
    return Settings(
        music_root=music,
        data_root=data,
        max_scan_tracks=100,
        job_timeout_seconds=30,
        scnet_enabled=True,
        bs_roformer_enabled=True,
        msst_root=tmp_path / "msst",
        scnet_config_url="https://example.invalid/config",
        scnet_model_url="https://example.invalid/model",
    )


def test_slugify_title_keeps_word_boundaries():
    assert (
        slugify_title("Blind Guardian – Into the Storm")
        == "blind-guardian-into-the-storm"
    )
    assert share_slug(
        {
            "folder": "Blind Guardian/Nightfall in Middle‐Earth (1998)",
            "title": "Blind Guardian - Nightfall in Middle‐Earth - 02 - Into the Storm",
        }
    ) == "blind-guardian-into-the-storm"


def test_library_search_matches_words_across_artist_and_title(tmp_path: Path):
    root = tmp_path / "music"
    album = root / "Metallica" / "Metallica (1991)"
    album.mkdir(parents=True)
    (album / "01 - Enter Sandman.flac").write_bytes(b"audio")
    library = MusicLibrary(root)

    results = library.search("metallica enter")

    assert [track.title for track in results] == ["01 - Enter Sandman"]


def test_library_search_ignores_artist_diacritics(tmp_path: Path):
    root = tmp_path / "music"
    album = root / "Mýa" / "Moodring"
    album.mkdir(parents=True)
    (album / "Fallen.flac").write_bytes(b"audio")

    assert [track.title for track in MusicLibrary(root).search("mya")] == ["Fallen"]


def test_library_indexes_all_supported_tracks_without_a_limit(tmp_path: Path):
    root = tmp_path / "music"
    root.mkdir()
    for name in ["one.flac", "two.wma", "three.wv"]:
        (root / name).write_bytes(b"audio")

    library = MusicLibrary(root, max_tracks=0)

    assert {track.extension for track in library.scan()} == {"flac", "wma", "wv"}


def test_library_can_refresh_instantly_from_navidrome_catalog(tmp_path: Path):
    root = tmp_path / "music"
    song = root / "Journey" / "Escape" / "01 - Don't Stop Believin'.flac"
    song.parent.mkdir(parents=True)
    song.write_bytes(b"audio")
    catalog = tmp_path / "navidrome.db"
    connection = sqlite3.connect(catalog)
    connection.execute("CREATE TABLE media_file (path TEXT, title TEXT, size INTEGER, suffix TEXT, artist TEXT, album TEXT, missing BOOLEAN)")
    connection.execute(
        "INSERT INTO media_file VALUES (?, ?, ?, ?, ?, ?, 0)",
        (song.relative_to(root).as_posix(), "Don't Stop Believin'", 5, "flac", "Journey", "Escape"),
    )
    connection.commit()
    connection.close()

    library = MusicLibrary(root, max_tracks=0, catalog_path=catalog)

    assert [track.title for track in library.search("journey believin")] == ["Don't Stop Believin'"]


def test_challenge_genres_use_navidrome_tags():
    tracks = [
        Track("1", "a", "Odd Meter", "Artist", "flac", 1, 0, genres=("Progressive Metal", "Djent")),
        Track("2", "b", "Pocket", "Artist", "flac", 1, 0, genres=("Funk", "Soul")),
    ]

    assert track_genres(tracks[0]) >= {"metal", "progressive"}
    counts = {item["id"]: item["count"] for item in genre_options(tracks)}
    assert counts["funk"] == 1
    assert counts["soul-rnb"] == 1
    assert draw_track(tracks, "progressive").id == "1"


def test_youtube_challenges_request_and_keep_original_songs():
    query = youtube_challenge_query("rock")
    assert "official" in query
    assert is_original_song_result({"title": "Band - Real Song (Official Audio)"})
    assert not is_original_song_result(
        {"title": "Band - Real Song (Drumless Backing Track)"}
    )
    assert not is_original_song_result({"title": "Greatest Rock Songs Playlist"})


def test_waveform_builds_display_peaks_and_caches_them(tmp_path: Path, monkeypatch):
    config = settings(tmp_path)
    store = JobStore(config.data_root / "jobs")
    output = store.output_path("job", "roformer")
    output.parent.mkdir(parents=True)
    output.write_bytes(b"audio")
    processor = Processor(config, MusicLibrary(config.music_root), store)
    pcm = array("h", [0, 1000, -2000, 32767] * 1000).tobytes()
    calls = []

    def fake_run(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout=pcm, stderr=b"")

    monkeypatch.setattr(subprocess, "run", fake_run)
    first = processor.waveform("job", "roformer", 400)
    second = processor.waveform("job", "roformer", 400)

    assert first == second
    assert first["points"] == 400
    assert 0 < max(first["peaks"]) <= 1
    assert len(calls) == 1

    custom_mix = store.root / "job" / "roformer" / "mixes" / "abc123.flac"
    custom_mix.parent.mkdir(parents=True)
    custom_mix.write_bytes(b"custom audio")
    custom = processor.waveform("job", "roformer", 400, "abc123")
    assert custom["points"] == 400
    assert len(calls) == 2
    assert str(custom_mix) in calls[-1][0][calls[-1][0].index("-i") + 1]


def test_pitch_variant_preserves_tempo_and_is_cached(tmp_path: Path, monkeypatch):
    config = settings(tmp_path)
    store = JobStore(config.data_root / "jobs")
    source = store.output_path("job", "roformer")
    source.parent.mkdir(parents=True)
    source.write_bytes(b"audio")
    processor = Processor(config, MusicLibrary(config.music_root), store)
    calls = []

    def fake_run(command):
        calls.append(command)
        Path(command[-1]).write_bytes(b"shifted")

    monkeypatch.setattr(processor, "_run", fake_run)
    first, first_id = processor.render_pitch_variant("job", "roformer", source, -2)
    second, second_id = processor.render_pitch_variant("job", "roformer", source, -2)

    assert first == second
    assert first_id == second_id
    assert first.read_bytes() == b"shifted"
    assert len(calls) == 1
    audio_filter = calls[0][calls[0].index("-af") + 1]
    assert "asetrate=44100*" in audio_filter
    assert "atempo=" in audio_filter


def test_library_automatically_rescans_after_cache_expires(tmp_path: Path):
    root = tmp_path / "music"
    root.mkdir()
    library = MusicLibrary(root, cache_seconds=0)
    assert library.search("") == []

    (root / "New Song.flac").write_bytes(b"audio")

    assert [track.title for track in library.search("new song")] == ["New Song"]


def test_library_and_job_creation(tmp_path: Path):
    config = settings(tmp_path)
    album = config.music_root / "Artist" / "Album"
    album.mkdir(parents=True)
    (album / "Song.mp3").write_bytes(b"not-real-audio")
    (album / "cover.jpg").write_bytes(b"ignored")

    app = create_app(config, start_worker=False)
    with TestClient(app) as client:
        library = client.get("/api/library").json()
        assert library["total"] == 1
        assert library["tracks"][0]["title"] == "Song"

        response = client.post("/api/jobs", json={"track_id": library["tracks"][0]["id"]})
        assert response.status_code == 202
        job = response.json()
        assert job["status"] == "queued"
        assert set(job["models"]) == {"scnet", "roformer"}

        fetched = client.get(f"/api/jobs/{job['id']}")
        assert fetched.status_code == 200
        assert fetched.json()["track"]["relative_path"] == "Artist/Album/Song.mp3"
        named_page = client.get(f"/jobs/{job['id']}", follow_redirects=False)
        assert named_page.status_code == 307
        assert named_page.headers["location"] == "/songs/artist-song"
        app.state.store.update(
            job["id"],
            lambda saved: (
                saved.update(status="complete"),
                saved["models"]["roformer"].update(status="complete"),
            ),
        )
        completed = client.get("/api/completed").json()["completed"]
        assert completed[0]["track"]["title"] == "Song"
        assert completed[0]["share_url"] == "/songs/artist-song"
        assert client.get("/api/songs/artist-song").json()["id"] == job["id"]


def test_youtube_only_mode_blocks_private_sources_and_attests_imports(tmp_path: Path, monkeypatch):
    config = replace(settings(tmp_path), youtube_only=True, media_extractor_enabled=True)
    app = create_app(config, start_worker=False)
    monkeypatch.setattr(app.state.imports, "import_url", lambda url, title="": SimpleNamespace(as_dict=lambda: {"id": "yt", "title": title}))
    with TestClient(app) as client:
        session = client.get("/api/session").json()
        assert session["source_mode"] == "youtube"
        assert session["user"].startswith("Guest-")
        assert "grooveslate_guest" in client.cookies
        assert client.get("/api/library").status_code == 404
        assert client.post("/api/imports/upload", files={"file": ("song.mp3", b"audio")}).status_code == 404
        assert client.post("/api/imports/url", json={"url": "https://youtu.be/test"}).status_code == 400
        response = client.post("/api/imports/url", json={"url": "https://youtu.be/test", "title": "Song", "rights_confirmed": True})
        assert response.status_code == 201
        assert response.json()["track"]["title"] == "Song"


def test_youtube_challenge_draws_from_search(tmp_path: Path, monkeypatch):
    app = create_app(replace(settings(tmp_path), youtube_only=True), start_worker=False)
    monkeypatch.setattr(app.state.imports, "search", lambda query, limit: [{"id": "video", "url": "https://youtu.be/video", "title": "Funk Song", "channel": "Band", "duration": 180}])
    with TestClient(app) as client:
        genres = client.get("/api/challenges/genres").json()
        assert genres["source"] == "youtube"
        assert len(genres["genres"]) == 15
        draw = client.post("/api/challenges/draw", json={"genre": "funk"}).json()
        assert draw["youtube_url"] == "https://youtu.be/video"
        assert draw["track"]["artist"] == "Band"


def test_public_youtube_mode_rate_limits_gpu_jobs(tmp_path: Path):
    app = create_app(replace(settings(tmp_path), youtube_only=True), start_worker=False)
    with TestClient(app) as client:
        for _ in range(3):
            assert client.post("/api/jobs", json={"track_id": "missing"}).status_code == 404
        assert client.post("/api/jobs", json={"track_id": "missing"}).status_code == 429


def test_practice_chart_and_recorded_takes_are_persistent_and_private(tmp_path: Path):
    config = replace(
        settings(tmp_path),
        app_password="test-password",
        session_secret="test-session-secret",
    )
    source = config.music_root / "Artist" / "Song.flac"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"audio")
    app = create_app(config, start_worker=False)
    track = app.state.library.scan()[0]
    job = app.state.store.create(track, "Pat")
    app.state.store.update(
        job["id"],
        lambda saved: (
            saved.update(status="complete"),
            saved["models"]["roformer"].update(status="complete"),
        ),
    )

    with TestClient(app) as client:
        client.post(
            "/login",
            data={"username": "Pat", "password": "test-password", "next": "/"},
        )
        chart = client.put(
            f"/api/jobs/{job['id']}/practice",
            json={
                "markers": [
                    {"id": "chorus-1", "time": 42.5, "label": "Chorus", "note": "Crash", "kind": "chorus"},
                    {"id": "intro", "time": 0, "label": "Intro", "note": "", "kind": "intro"},
                ],
                "settings": {"bpm": 128, "count_in_bars": 1, "metronome": True, "backing_volume": 0.7},
            },
        )
        assert chart.status_code == 200
        assert [marker["id"] for marker in chart.json()["markers"]] == ["intro", "chorus-1"]
        assert chart.json()["settings"]["bpm"] == 128

        uploaded = client.post(
            f"/api/jobs/{job['id']}/practice/takes",
            data={
                "name": "Take 1",
                "notes": "Strong ending",
                "duration": "123.4",
                "midi_events": '[{"kind":"note","time_ms":100,"channel":9,"note":38,"velocity":112},{"kind":"cc","time_ms":120,"channel":9,"control":4,"value":40}]',
            },
            files={"file": ("take.webm", b"recording" * 64, "audio/webm")},
        )
        assert uploaded.status_code == 201
        take = uploaded.json()["takes"][0]
        assert take["name"] == "Take 1"
        assert take["analysis"]["hit_count"] == 1
        assert take["analysis"]["pieces"] == {"snare": 1}
        assert client.get(take["audio_url"]).content == b"recording" * 64
        assert client.get(take["events_url"]).json()["events"][0]["note"] == 38
        midi = client.get(take["midi_url"])
        assert midi.status_code == 200
        assert midi.content.startswith(b"MThd")
        assert b"MTrk" in midi.content

        published = client.post(
            f"/api/jobs/{job['id']}/practice/takes/{take['id']}/publish"
        )
        assert published.status_code == 201
        publication = published.json()
        assert publication["owned"] is True
        assert client.get(publication["audio_url"]).content == b"recording" * 64
        assert client.put(
            f"/api/community/{publication['id']}/score", json={"score": 5}
        ).status_code == 400

        marked = client.patch(
            f"/api/jobs/{job['id']}/practice/takes/{take['id']}",
            json={"best": True, "name": "Keeper"},
        )
        assert marked.json()["takes"][0]["best"] is True
        assert marked.json()["takes"][0]["name"] == "Keeper"
        summary = client.get("/api/completed").json()["completed"][0]["practice"]
        assert summary == {"marker_count": 2, "take_count": 1, "has_best_take": True}

        client.get("/logout")
        client.post(
            "/login",
            data={"username": "Bob", "password": "test-password", "next": "/"},
        )
        assert client.get(f"/api/jobs/{job['id']}/practice").status_code == 404
        assert client.get(take["audio_url"]).status_code == 404
        assert client.get(take["events_url"]).status_code == 404
        community = client.get("/api/community").json()["takes"]
        assert community[0]["owner"] == "Pat"
        assert community[0]["owned"] is False
        scored = client.put(
            f"/api/community/{publication['id']}/score", json={"score": 4}
        )
        assert scored.status_code == 200
        assert scored.json()["score"] == 4
        assert scored.json()["score_count"] == 1


def test_auto_map_saves_an_editable_private_chart(tmp_path: Path, monkeypatch):
    config = replace(settings(tmp_path), app_password="test-password", session_secret="secret")
    source = config.music_root / "Artist" / "Mapped Song.flac"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"audio")
    app = create_app(config, start_worker=False)
    track = app.state.library.scan()[0]
    job = app.state.store.create(track, "Pat")
    analysis = {
        "bpm": 126, "time_signature": "4/4", "duration": 180, "beats": [0, .476, .952],
        "method": "test", "markers": [{"id": "auto-0", "time": 0, "label": "Intro", "note": "8 bars", "kind": "intro", "bar": 1, "bars": 8, "confidence": .8, "dynamics": "low", "groove": "steady"}],
    }
    monkeypatch.setattr(app.state.song_mapper, "analyze", lambda _: analysis)

    with TestClient(app) as client:
        client.post("/login", data={"username": "Pat", "password": "test-password", "next": "/"})
        mapped = client.post(f"/api/jobs/{job['id']}/practice/auto-map")
        assert mapped.status_code == 200
        assert mapped.json()["settings"]["bpm"] == 126
        assert mapped.json()["markers"][0]["bars"] == 8
        saved = client.get(f"/api/jobs/{job['id']}/practice").json()
        assert saved["auto_map"]["method"] == "test"
        client.get("/logout")
        client.post("/login", data={"username": "Bob", "password": "test-password", "next": "/"})
        assert client.post(f"/api/jobs/{job['id']}/practice/auto-map").status_code == 404


def test_unknown_track_is_not_exposed(tmp_path: Path):
    config = settings(tmp_path)
    app = create_app(config, start_worker=False)
    with TestClient(app) as client:
        assert client.get("/api/tracks/not-a-track/stream").status_code == 404
        assert client.post("/api/jobs", json={"track_id": "../secret"}).status_code == 404


def test_frontend_and_health(tmp_path: Path):
    config = settings(tmp_path)
    app = create_app(config, start_worker=False)
    with TestClient(app) as client:
        homepage = client.get("/")
        assert homepage.status_code == 200
        assert 'data-theme="dark"' in homepage.text
        assert 'class="practice-home"' in homepage.text
        assert "Practice library" in homepage.text
        assert 'id="resume-latest"' in homepage.text
        assert 'id="home-practice-grid"' in homepage.text
        assert 'class="brand" href="/"' in homepage.text
        assert 'src="/logo.svg"' in homepage.text
        assert "Only import media you’re permitted to use." in homepage.text
        assert "rights-confirmed" not in homepage.text
        assert 'id="session-studio"' in homepage.text
        assert 'id="global-progress"' in homepage.text
        assert 'id="new-song-button"' in homepage.text
        assert "CHOOSE YOUR PRACTICE MIX" in homepage.text
        assert client.get("/logo.svg").status_code == 200
        assert client.get("/manifest.webmanifest").status_code == 200
        assert client.get("/service-worker.js").status_code == 200
        assert client.get("/practice.js").status_code == 200
        assert client.get("/drum-kit/kick.wav").status_code == 200
        assert client.get("/drum-kit/studio/AcousticSnare/HV1.wav").status_code == 200
        assert client.get("/drum-kit/LICENSE.md").status_code == 200
        javascript = client.get("/app.js").text
        assert 'api("/api/jobs?limit=1")' not in javascript
        assert "if (songMatch)" in javascript
        assert "await replaceAudioSource" in javascript
        assert 'excluded.length === 1 && excluded[0] === "drums"' in javascript
        assert "function beginActivity" in javascript
        assert "Drawing a full-song challenge" in javascript
        assert "function selectChallengeGenre" in javascript
        assert 'id="draw-selected-genre"' in homepage.text
        assert 'accept.textContent = "Preparing song…"' in javascript
        assert '["Play bass", ["bass"]]' in javascript
        assert "function applyPitch" in javascript
        assert "tabforge.pathtpc.xyz/library" in client.get("/practice.js").text
        assert "Capture at the actual swap" in javascript
        assert 'url.includes("?") ? "&" : "?"' in javascript
        assert "current mix keeps playing" in javascript
        assert 'new CustomEvent("drumless:mix-changed"' in javascript
        assert "Updating waveform for the selected mix" in javascript
        assert javascript.index("const local = await api(`/api/library") < javascript.index(
            "const remote = await api(`/api/imports/search"
        )
        health = client.get("/api/health").json()
        assert health["status"] == "ok"
        assert health["library_available"] is True
        assert health["imports"]["uploads"] is True
        assert health["imports"]["media_extractor"] is False


def test_uploaded_audio_becomes_a_processable_track(tmp_path: Path):
    config = settings(tmp_path)
    app = create_app(config, start_worker=False)
    with TestClient(app) as client:
        response = client.post(
            "/api/imports/upload",
            files={"file": ("Practice Song.mp3", b"fake-audio", "audio/mpeg")},
        )
        assert response.status_code == 201
        track = response.json()["track"]
        assert track["title"] == "Practice Song"
        assert track["source_type"] == "upload"
        assert track["folder"] == "Imports/Uploads"

        job = client.post("/api/jobs", json={"track_id": track["id"]})
        assert job.status_code == 202
        assert job.json()["track"]["id"] == track["id"]
        assert app.state.library.path_for(track["id"]).read_bytes() == b"fake-audio"


def test_upload_rejects_unsupported_and_oversized_files(tmp_path: Path):
    config = replace(settings(tmp_path), max_import_bytes=4)
    app = create_app(config, start_worker=False)
    with TestClient(app) as client:
        unsupported = client.post(
            "/api/imports/upload",
            files={"file": ("notes.txt", b"text", "text/plain")},
        )
        assert unsupported.status_code == 400
        oversized = client.post(
            "/api/imports/upload",
            files={"file": ("song.mp3", b"12345", "audio/mpeg")},
        )
        assert oversized.status_code == 400


def test_remote_imports_reject_private_hosts_and_disabled_youtube(tmp_path: Path):
    config = settings(tmp_path)
    app = create_app(config, start_worker=False)
    with TestClient(app) as client:
        private = client.post(
            "/api/imports/url",
            json={"url": "http://127.0.0.1/private.mp3"},
        )
        assert private.status_code == 400
        youtube = client.post(
            "/api/imports/url",
            json={"url": "https://www.youtube.com/watch?v=test"},
        )
        assert youtube.status_code == 400
        assert "disabled" in youtube.json()["detail"].lower()


def test_import_manifest_is_loaded_after_restart(tmp_path: Path):
    config = settings(tmp_path)
    first_library = MusicLibrary(
        config.music_root,
        import_root=config.data_root / "imports",
    )
    imported = ImportService(config, first_library).import_upload(
        "Restart Song.flac",
        stream=BytesIO(b"persisted"),
    )

    restarted = MusicLibrary(
        config.music_root,
        import_root=config.data_root / "imports",
    )
    restored = restarted.get(imported.id)

    assert restored.title == "Restart Song"
    assert restored.source_type == "upload"
    assert restarted.path_for(restored.id).read_bytes() == b"persisted"


def test_password_gate_protects_app_and_api(tmp_path: Path):
    config = replace(
        settings(tmp_path),
        app_password="test-password",
        session_secret="test-session-secret",
    )
    app = create_app(config, start_worker=False)
    with TestClient(app) as client:
        page = client.get("/", follow_redirects=False)
        assert page.status_code == 303
        assert page.headers["location"].startswith("/login?next=")
        assert client.get("/api/library").status_code == 401
        login_page = client.get("/login").text
        assert '<option value="Pat">Pat — Admin</option>' in login_page
        assert '<option value="Bob">Bob</option>' in login_page

        rejected = client.post(
            "/login",
            data={"username": "Pat", "password": "wrong", "next": "/"},
        )
        assert rejected.status_code == 200
        assert "correct password" in rejected.text

        accepted = client.post(
            "/login",
            data={"username": "Pat", "password": "test-password", "next": "/"},
            follow_redirects=False,
        )
        assert accepted.status_code == 303
        assert accepted.headers["location"] == "/"
        assert "drumless_session" in accepted.cookies
        assert client.get("/api/library").status_code == 200
        session = client.get("/api/session").json()
        assert session["user"] == "Pat"
        assert session["role"] == "admin"


def test_practice_library_and_job_assets_are_private(tmp_path: Path):
    config = replace(
        settings(tmp_path),
        app_password="test-password",
        session_secret="test-session-secret",
    )
    source = config.music_root / "Song.mp3"
    source.write_bytes(b"audio")
    app = create_app(config, start_worker=False)
    track = app.state.library.scan()[0]
    pat_job = app.state.store.create(track, "Pat")
    app.state.store.update(
        pat_job["id"],
        lambda saved: (
            saved.update(status="complete"),
            saved["models"]["roformer"].update(status="complete"),
        ),
    )

    with TestClient(app) as client:
        client.post(
            "/login",
            data={"username": "Pat", "password": "test-password", "next": "/"},
        )
        pat_tracks = client.get("/api/completed").json()["completed"]
        assert [item["job_id"] for item in pat_tracks] == [pat_job["id"]]
        assert pat_tracks[0]["audio_url"].endswith("/audio/roformer")

        client.get("/logout")
        client.post(
            "/login",
            data={"username": "Bob", "password": "test-password", "next": "/"},
        )
        assert client.get("/api/session").json()["user"] == "Bob"
        assert client.get("/api/session").json()["role"] == "member"
        assert client.get("/api/library").status_code == 200
        assert client.get("/api/completed").json()["completed"] == []
        assert client.get(f"/api/jobs/{pat_job['id']}").status_code == 404
        assert client.get(f"/api/jobs/{pat_job['id']}/audio/roformer").status_code == 404
        assert client.get(f"/songs/{share_slug(pat_job['track'])}").status_code == 404

        bob_job = app.state.store.create(track, "Bob")
        app.state.store.update(
            bob_job["id"],
            lambda saved: (
                saved.update(status="complete"),
                saved["models"]["roformer"].update(status="complete"),
            ),
        )
        bob_tracks = client.get("/api/completed").json()["completed"]
        assert [item["job_id"] for item in bob_tracks] == [bob_job["id"]]
        assert bob_tracks[0]["user"] == "Bob"

        client.get("/logout")
        client.post(
            "/login",
            data={"username": "Pat", "password": "test-password", "next": "/"},
        )
        assert client.get(f"/api/jobs/{bob_job['id']}").status_code == 404


def test_legacy_jobs_are_assigned_to_first_user(tmp_path: Path):
    config = replace(
        settings(tmp_path),
        app_password="test-password",
        session_secret="test-session-secret",
    )
    source = config.music_root / "Song.mp3"
    source.write_bytes(b"audio")
    library = MusicLibrary(config.music_root)
    track = library.scan()[0]
    store = JobStore(config.data_root / "jobs")
    legacy = store.create(track)

    app = create_app(config, start_worker=False)

    assert app.state.store.get(legacy["id"])["user"] == "Pat"


def test_queue_recovers_interrupted_job_without_resetting_complete_model(
    tmp_path: Path,
):
    config = settings(tmp_path)
    library = MusicLibrary(config.music_root)
    store = JobStore(config.data_root / "jobs")
    processor = Processor(config, library, store)
    track = Track(
        id="track-1",
        relative_path="Artist/Album/Song.flac",
        title="Artist - Album - 01 - Song",
        folder="Artist/Album",
        extension="flac",
        size=1,
        modified=1,
    )
    job = store.create(track)
    store.update(
        job["id"],
        lambda data: (
            data.update(status="processing"),
            data["models"]["scnet"].update(status="complete", progress=100),
            data["models"]["roformer"].update(status="processing", progress=42),
        ),
    )

    queue = JobQueue(processor, start_worker=False)
    recovered = store.get(job["id"])

    assert recovered["status"] == "queued"
    assert recovered["models"]["scnet"]["status"] == "complete"
    assert recovered["models"]["roformer"]["status"] == "queued"
    assert queue.queue.get_nowait() == job["id"]


def test_processor_skips_complete_model_with_existing_output(
    tmp_path: Path,
    monkeypatch,
):
    config = replace(settings(tmp_path), bs_roformer_enabled=False)
    source = config.music_root / "Artist" / "Album" / "Song.flac"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    library = MusicLibrary(config.music_root)
    track = library.scan()[0]
    store = JobStore(config.data_root / "jobs")
    processor = Processor(config, library, store)
    job = store.create(track)
    output = store.output_path(job["id"], "scnet")
    output.parent.mkdir(parents=True)
    output.write_bytes(b"finished")
    store.update(
        job["id"],
        lambda data: data["models"]["scnet"].update(
            status="complete",
            progress=100,
        ),
    )
    monkeypatch.setattr(processor, "_prepare_source", lambda *_: source)
    monkeypatch.setattr(
        processor,
        "run_scnet",
        lambda *_: pytest.fail("completed SCNet model was rerun"),
    )

    processor.process(job["id"])

    finished = store.get(job["id"])
    assert finished["status"] == "complete"
    assert finished["models"]["scnet"]["status"] == "complete"


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")
def test_drum_subtraction_uses_phase_inversion(tmp_path: Path):
    config = settings(tmp_path)
    source = tmp_path / "source.wav"
    drums = tmp_path / "drums.wav"
    output = tmp_path / "no-drums.flac"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.25",
            str(source),
        ],
        check=True,
    )
    shutil.copyfile(source, drums)
    processor = Processor(
        config,
        MusicLibrary(config.music_root),
        JobStore(config.data_root / "jobs"),
    )
    processor._make_drumless(source, drums, output)
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(output),
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    assert "mean_volume: -91.0 dB" in result.stdout


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is required")
def test_stem_mix_can_remove_stems_and_restore_all(tmp_path: Path):
    config = settings(tmp_path)
    store = JobStore(config.data_root / "jobs")
    processor = Processor(config, MusicLibrary(config.music_root), store)
    stems = store.root / "job-1" / "roformer" / "stems"
    stems.mkdir(parents=True)
    for name, frequency in (("drums", 220), ("bass", 440), ("vocals", 880)):
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={frequency}:duration=0.25",
                str(stems / f"source_{name}.wav"),
            ],
            check=True,
        )

    without_drums, without_drums_id = processor.render_stem_mix(
        "job-1", "roformer", ["drums"]
    )
    all_stems, all_stems_id = processor.render_stem_mix("job-1", "roformer", [])

    assert without_drums.is_file()
    assert all_stems.is_file()
    assert without_drums_id != all_stems_id
    assert without_drums.read_bytes() != all_stems.read_bytes()
