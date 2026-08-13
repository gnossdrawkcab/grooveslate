from __future__ import annotations

from collections import Counter
from secrets import choice

from .library import Track


GENRES: dict[str, tuple[str, ...]] = {
    "rock": ("rock", "grunge", "shoegaze"),
    "hard-rock": ("hard rock", "arena rock", "classic rock", "glam rock"),
    "metal": ("metal", "djent", "grindcore"),
    "punk": ("punk", "hardcore", "emo", "ska"),
    "alternative": ("alternative", "indie rock", "post-rock", "noise rock"),
    "pop": ("pop", "new wave"),
    "funk": ("funk", "disco", "boogie"),
    "soul-rnb": ("soul", "r&b", "rhythm and blues", "motown"),
    "jazz": ("jazz", "bebop", "swing", "fusion"),
    "blues": ("blues",),
    "country": ("country", "americana", "bluegrass"),
    "hip-hop": ("hip hop", "hip-hop", "rap", "boom bap", "trap"),
    "electronic": ("electronic", "house", "techno", "ambient", "idm", "downtempo", "electro"),
    "reggae-ska": ("reggae", "dub", "ska", "rocksteady"),
    "progressive": ("progressive", "prog rock", "prog metal", "art rock"),
}

GENRE_LABELS = {
    "rock": "Rock", "hard-rock": "Hard Rock", "metal": "Metal", "punk": "Punk & Hardcore",
    "alternative": "Alternative & Indie", "pop": "Pop", "funk": "Funk & Disco",
    "soul-rnb": "Soul & R&B", "jazz": "Jazz & Fusion", "blues": "Blues",
    "country": "Country & Americana", "hip-hop": "Hip-Hop", "electronic": "Electronic",
    "reggae-ska": "Reggae & Ska", "progressive": "Progressive",
}

YOUTUBE_CHALLENGE_QUERIES = {
    key: (f"{label} drum play along", f"{label} drumless backing track", f"{label} song official audio")
    for key, label in GENRE_LABELS.items()
}

CHALLENGES = (
    {"kind": "pocket", "title": "Pocket lock", "instruction": "Chart at least four sections, record a full take, and reach a Pocket score of 75.", "target": 75},
    {"kind": "improve", "title": "Beat your first take", "instruction": "Record two full takes. Keep take one honest, then improve your Pocket score on take two.", "target": 2},
    {"kind": "dynamics", "title": "Shape the song", "instruction": "Chart the form, record a full take, and create at least 45 points of MIDI dynamic range.", "target": 45},
    {"kind": "one-take", "title": "One-take commitment", "instruction": "Listen once, chart the major sections, then record one uninterrupted full take.", "target": 1},
    {"kind": "deep-chart", "title": "Chart before chops", "instruction": "Mark at least six musical sections or cues before recording your full take.", "target": 6},
)


def track_genres(track: Track) -> set[str]:
    tags = [tag.casefold().replace("_", " ") for tag in track.genres]
    matches = set()
    for key, aliases in GENRES.items():
        if any(alias in tag for alias in aliases for tag in tags):
            matches.add(key)
    return matches


def genre_counts(tracks: list[Track], eligible_ids: set[str] | None = None) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for track in tracks:
        if eligible_ids is not None and track.id not in eligible_ids:
            continue
        counts.update(track_genres(track))
    return dict(counts)


def genre_options(tracks: list[Track], eligible_ids: set[str] | None = None) -> list[dict]:
    counts = genre_counts(tracks, eligible_ids)
    return [
        {"id": key, "label": GENRE_LABELS[key], "count": counts.get(key, 0)}
        for key in GENRES
    ]


def youtube_genre_options() -> list[dict]:
    return [{"id": key, "label": GENRE_LABELS[key], "count": None} for key in GENRES]


def youtube_challenge_query(genre: str) -> str:
    try:
        return choice(YOUTUBE_CHALLENGE_QUERIES[genre])
    except KeyError:
        raise KeyError(genre) from None


def draw_track(tracks: list[Track], genre: str, eligible_ids: set[str] | None = None) -> Track:
    if genre not in GENRES:
        raise KeyError(genre)
    pool = [
        track for track in tracks
        if genre in track_genres(track) and (eligible_ids is None or track.id in eligible_ids)
    ]
    if not pool:
        raise LookupError(genre)
    return choice(pool)


def draw_challenge() -> dict:
    return dict(choice(CHALLENGES))
