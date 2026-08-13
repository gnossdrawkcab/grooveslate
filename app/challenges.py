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
    "rock": ("Queen Don't Stop Me Now official", "Foo Fighters Everlong official", "The Killers Mr Brightside official"),
    "hard-rock": ("ACDC Back In Black official", "Guns N Roses Welcome To The Jungle official", "Van Halen Panama official"),
    "metal": ("Metallica Enter Sandman official", "Iron Maiden The Trooper official", "Judas Priest Painkiller official"),
    "punk": ("Ramones Blitzkrieg Bop official", "Green Day Basket Case official", "The Clash Should I Stay Or Should I Go official"),
    "alternative": ("Nirvana Come As You Are official", "Radiohead Creep official", "Arctic Monkeys Do I Wanna Know official"),
    "pop": ("Michael Jackson Billie Jean official", "Dua Lipa Levitating official", "The Weeknd Blinding Lights official"),
    "funk": ("Prince Kiss official", "James Brown Get Up Offa That Thing official", "Vulfpeck Dean Town official"),
    "soul-rnb": ("Stevie Wonder Superstition official", "Aretha Franklin Respect official", "Marvin Gaye What's Going On official"),
    "jazz": ("Dave Brubeck Take Five official", "Herbie Hancock Chameleon official", "Miles Davis So What official"),
    "blues": ("BB King The Thrill Is Gone official", "Stevie Ray Vaughan Pride And Joy official", "Muddy Waters Mannish Boy official"),
    "country": ("Johnny Cash Folsom Prison Blues official", "Dolly Parton Jolene official", "Chris Stapleton Tennessee Whiskey official"),
    "hip-hop": ("Outkast Ms Jackson official", "Nas NY State Of Mind official", "A Tribe Called Quest Scenario official"),
    "electronic": ("Daft Punk Get Lucky official", "The Chemical Brothers Block Rockin Beats official", "Justice DANCE official"),
    "reggae-ska": ("Bob Marley Could You Be Loved official", "Toots and the Maytals 54-46 official", "Sublime Santeria official"),
    "progressive": ("Rush Tom Sawyer official", "Yes Roundabout official", "Tool Schism official"),
}

NON_ORIGINAL_RESULT_TERMS = (
    "drumless",
    "drums removed",
    "without drums",
    "backing track",
    "play along",
    "play-along",
    "karaoke",
    "minus drums",
    "drum cover",
    "drums only",
    "isolated drums",
    "with metal drums",
    "playlist",
    "full album",
    "compilation",
    "reaction",
    "tutorial",
    " cover",
)

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


def is_original_song_result(result: dict) -> bool:
    title = str(result.get("title") or "").casefold()
    return not any(term in title for term in NON_ORIGINAL_RESULT_TERMS)


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
