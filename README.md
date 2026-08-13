# GrooveSlate

GrooveSlate is a self-hosted drum practice studio for making drum-free tracks,
charting the song form, playing with a low-latency sampled e-kit, and capturing
finished takes. Sources can come from a server-side music library, uploaded
audio, or an imported direct audio URL. Separation uses:

- SCNet XL IHF
- BS-RoFormer-SW

The original library is mounted read-only. Generated stems and drumless mixes
are stored separately under `/data`.

## Run

The supplied Compose file targets an NVIDIA host:

```bash
cp app.env.example app.env
docker compose up --build
```

Open `http://localhost:8097`.

Set `MUSIC_PATH` and `DATA_PATH` in your shell or Compose `.env` when those
directories live outside the project. To use Navidrome's fast catalog, mount
its data directory and set `NAVIDROME_DB_PATH` to the database path inside the
container.

Environment variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `MUSIC_ROOT` | `/music` | Read-only server music directory |
| `DATA_ROOT` | `/data` | Model cache, jobs, and output |
| `MAX_SCAN_TRACKS` | `0` | Library scan limit (`0` indexes the complete library) |
| `LIBRARY_CACHE_SECONDS` | `300` | Seconds before the server automatically rescans the music library |
| `NAVIDROME_DB_PATH` | empty | Optional read-only Navidrome database for instant complete-library indexing |
| `JOB_TIMEOUT_SECONDS` | `7200` | Timeout per model |
| `SCNET_ENABLED` | `1` | Enable SCNet jobs |
| `BS_ROFORMER_ENABLED` | `1` | Enable BS-RoFormer jobs |
| `SCNET_MODEL_URL` | official MSST release | SCNet checkpoint |
| `SCNET_CONFIG_URL` | official MSST release | SCNet configuration |
| `MEDIA_EXTRACTOR_ENABLED` | `0` | Enable private `yt-dlp` URL importing and YouTube search |
| `MAX_IMPORT_BYTES` | `262144000` | Maximum upload, direct download, or extracted audio size |
| `MAX_IMPORT_DURATION_SECONDS` | `900` | Maximum duration accepted by the media extractor |
| `APP_PASSWORD` | empty | Shared password required to enter the app |
| `APP_USERS` | `Pat,Bob` | Comma-separated personal practice-library users |
| `APP_ADMIN_USERS` | `Pat` | Users allowed to browse server music, upload, and use direct URLs |

## Practice studio

Every completed separation has a private, per-user song workbench with four
stages: Listen, Chart, Practice, and Record. Drummers can add timestamped song
sections and performance notes, use A/B loops, change playback speed, set a
tempo, tap tempo, enable a metronome, and launch playback with a count-in.

The chart is a drummer-focused road map with bar numbers, rehearsal marks,
section lengths, dynamics, groove texture, and dedicated cues for fills, band
hits, stops, pushes, ride/hat moves, builds, and half-time. Auto-map performs
beat-synchronous structural analysis on the local working audio, snaps section
boundaries to detected beats, finds repeated A/B/C material, estimates bars and
energy, and saves the result as a fully editable first draft. It does not claim
to know whether ambiguous repeated material is a verse or chorus.

Each chart item can be renamed, retimed, given a bar count and dynamics, or
looped directly. Charts can be copied as rehearsal notes or printed without the
surrounding UI. A live cue strip follows playback with the current section,
drummer shorthand, bar progress, and next transition.

Recording supports a phone or laptop microphone, a USB audio interface or drum
module, and Web MIDI e-drums. The browser records the drumless backing and live
drum signal into one take. MIDI uses a bundled, multi-layer FreePats acoustic kit
with General MIDI mappings, velocity layers, round-robin alternates, and hi-hat
choke. Samples decode into browser memory before playing to keep MIDI response
immediate. GrooveSlate also saves the raw, editable MIDI performance beside the
audio, draws every hit against the full waveform and chart sections, reports
grid consistency and dynamics by section, compares attempt scores, and exports
standard MIDI for a DAW. Takes, notes, and the selected best take are saved
under `${DATA_ROOT}/practice` and can only be accessed by their owner. See
`app/static/drum-kit/LICENSE.md` for sample provenance.

The MIDI kit includes a persistent per-browser MIDI Learn map for nonstandard
e-kit note assignments. Snare velocity changes volume without swapping to a
thin low-velocity timbre, side-stick remains a separate articulation, cymbals
play at their natural recorded pitch, and sample pre-roll is trimmed for a
faster transient. Wired audio is recommended because Bluetooth output latency
cannot be removed by the browser.

## Challenge mode

Challenge Mode reads Navidrome's embedded genre tags and maps its detailed
styles into 15 drummer-friendly lanes. Pick a genre, choose the full library or
only prepared drumless tracks, and GrooveSlate draws a random song plus a
measurable mission. Missions cover pocket score, dynamics, charting, one-take
commitment, and improving a second take; progress follows the player into the
song workbench.

## YouTube and Community Takes

When the optional media extractor is enabled, the home page includes first-class
YouTube discovery with thumbnails, an external preview link, and one-click
import into the existing separation queue. Library results remain available in
the combined search, and imported songs stay private to the requesting user.

Takes can be recorded in the browser or uploaded from a phone, drum module, or
DAW and are private by default. A drummer may explicitly publish one to
Community Takes, where other signed-in users can listen and leave a replaceable
1–5 Groove score. Owners cannot score their own takes and can unpublish without
deleting their private recording; unpublishing also removes prior scores.

## Importing audio

The Import tab always accepts supported audio uploads and direct public audio
URLs. Imported files are stored under `${DATA_ROOT}/imports`, deduplicated for
repeat direct URLs, and exposed to the existing processing queue as ordinary
tracks.

Set `MEDIA_EXTRACTOR_ENABLED=1` to expose the optional private media extractor.
It adds YouTube search and permits individual YouTube URLs; playlists are
intentionally rejected. This mode is disabled by default because provider rules
and availability can change. Only process media you own or have permission to
use. YouTube's official Data API is not used by this feature.

## Development

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
pytest
uvicorn app.main:app --reload
```

Set `MUSIC_ROOT` to a local directory containing a few audio files. Model
commands are only invoked after a comparison job is submitted.
