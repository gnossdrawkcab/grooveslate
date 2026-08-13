from __future__ import annotations

from collections import Counter
import re
from secrets import choice, randbelow

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

# The familiar pool gives new players an approachable foothold; discovery and
# deep-cut pools prevent roulette from becoming the same greatest-hits list.
YOUTUBE_DISCOVERY_QUERIES = {
    "rock": ("The War on Drugs Red Eyes official audio", "Big Star September Gurls official audio", "Television See No Evil official audio"),
    "hard-rock": ("Thin Lizzy Emerald official audio", "UFO Rock Bottom official audio", "Living Colour Cult of Personality official audio"),
    "metal": ("Mastodon Blood and Thunder official audio", "Opeth Ghost of Perdition official audio", "Gojira Stranded official audio"),
    "punk": ("Bad Brains Banned in DC official audio", "Fugazi Waiting Room official audio", "Buzzcocks Ever Fallen in Love official audio"),
    "alternative": ("Dinosaur Jr Feel the Pain official audio", "Sonic Youth Kool Thing official audio", "Built to Spill Carry the Zero official audio"),
    "pop": ("Robyn Dancing On My Own official audio", "Carly Rae Jepsen Run Away With Me official audio", "HAIM The Wire official audio"),
    "funk": ("The Meters Cissy Strut official audio", "Parliament Flash Light official audio", "Lettuce Phyllis official audio"),
    "soul-rnb": ("D'Angelo Chicken Grease official audio", "Erykah Badu On and On official audio", "Donny Hathaway The Ghetto official audio"),
    "jazz": ("Billy Cobham Stratus official audio", "Weather Report Teen Town official audio", "Art Blakey Moanin official audio"),
    "blues": ("Albert King Born Under a Bad Sign official audio", "Freddie King Going Down official audio", "Gary Clark Jr Bright Lights official audio"),
    "country": ("Jason Isbell Cover Me Up official audio", "Sturgill Simpson Turtles All the Way Down official audio", "Emmylou Harris Luxury Liner official audio"),
    "hip-hop": ("The Roots The Seed 2.0 official audio", "De La Soul Stakes Is High official audio", "Gang Starr Mass Appeal official audio"),
    "electronic": ("Caribou Odessa official audio", "LCD Soundsystem Tribulations official audio", "Underworld Born Slippy official audio"),
    "reggae-ska": ("The Skatalites Guns of Navarone official audio", "Burning Spear Marcus Garvey official audio", "The Specials Ghost Town official audio"),
    "progressive": ("King Crimson Red official audio", "Porcupine Tree Blackest Eyes official audio", "Gentle Giant Proclamation official audio"),
}

YOUTUBE_DEEP_CUT_QUERIES = {
    "rock": ("Failure Stuck on You official audio", "Hum Stars official audio"),
    "hard-rock": ("Budgie Breadfan official audio", "Riot Swords and Tequila official audio"),
    "metal": ("Cynic Veil of Maya official audio", "Voivod Tribal Convictions official audio"),
    "punk": ("Drive Like Jehu Here Come the Rome Plows official audio", "Jawbreaker Boxcar official audio"),
    "alternative": ("Polvo Fast Canoe official audio", "The Dismemberment Plan The City official audio"),
    "pop": ("Jessie Ware Spotlight official audio", "Rina Sawayama XS official audio"),
    "funk": ("Mandrill Fencewalk official audio", "Cymande Bra official audio"),
    "soul-rnb": ("Shuggie Otis Strawberry Letter 23 official audio", "Betty Davis If I'm in Luck official audio"),
    "jazz": ("Tony Williams Fred official audio", "Mahavishnu Orchestra Vital Transformation official audio"),
    "blues": ("Junior Kimbrough Meet Me in the City official audio", "R L Burnside Goin Down South official audio"),
    "country": ("Lucinda Williams Joy official audio", "James McMurtry Choctaw Bingo official audio"),
    "hip-hop": ("Blackalicious Make You Feel That Way official audio", "Digable Planets 9th Wonder official audio"),
    "electronic": ("Autechre Bike official audio", "Floating Points Nuits Sonores official audio"),
    "reggae-ska": ("The Congos Fisherman official audio", "Augustus Pablo East of the River Nile official audio"),
    "progressive": ("Van der Graaf Generator Killer official audio", "Camel Lunar Sea official audio"),
}

YOUTUBE_EXTRA_QUERIES = {
    "rock": ("Spoon The Underdog official audio", "Wilco Heavy Metal Drummer official audio", "The Afghan Whigs Debonair official audio", "Queens of the Stone Age No One Knows official audio", "The Raconteurs Steady As She Goes official audio"),
    "hard-rock": ("Rival Sons Pressure and Time official audio", "The Cult Fire Woman official audio", "Clutch Electric Worry official audio", "Rainbow Stargazer official audio", "Deep Purple Burn official audio"),
    "metal": ("Meshuggah Bleed official audio", "Killswitch Engage My Curse official audio", "Baroness Take My Bones Away official audio", "High on Fire Snakes for the Divine official audio", "Death Symbolic official audio"),
    "punk": ("Refused New Noise official audio", "IDLES Never Fight a Man with a Perm official audio", "Turnstile Mystery official audio", "Rancid Time Bomb official audio", "At the Drive In One Armed Scissor official audio"),
    "alternative": ("Pavement Cut Your Hair official audio", "PJ Harvey Down by the Water official audio", "Modest Mouse Teeth Like God's Shoeshine official audio", "Yo La Tengo Sugarcube official audio", "The Breeders Cannonball official audio"),
    "pop": ("Charli XCX 360 official audio", "Caroline Polachek So Hot You're Hurting My Feelings official audio", "Chappell Roan Red Wine Supernova official audio", "MUNA Number One Fan official audio", "Magdalena Bay Image official audio"),
    "funk": ("Average White Band Pick Up the Pieces official audio", "Tower of Power What Is Hip official audio", "Sly and the Family Stone Thank You official audio", "Ohio Players Fire official audio", "Cory Wong Cosmic Sans official audio"),
    "soul-rnb": ("Jill Scott A Long Walk official audio", "Maxwell Ascension official audio", "Curtis Mayfield Move On Up official audio", "Sade Paradise official audio", "Anderson Paak Come Down official audio"),
    "jazz": ("Thelonious Monk Straight No Chaser official audio", "Charles Mingus Haitian Fight Song official audio", "Chick Corea Spain official audio", "John Coltrane Impressions official audio", "Yussef Dayes Black Classical Music official audio"),
    "blues": ("Howlin Wolf Smokestack Lightning official audio", "Buddy Guy Damn Right I've Got the Blues official audio", "Koko Taylor Wang Dang Doodle official audio", "Taj Mahal Leaving Trunk official audio", "Samantha Fish Faster official audio"),
    "country": ("Tyler Childers Whitehouse Road official audio", "Margo Price Hurtin on the Bottle official audio", "Drive By Truckers Outfit official audio", "Turnpike Troubadours Good Lord Lorrie official audio", "Waxahatchee Right Back to It official audio"),
    "hip-hop": ("Mos Def Mathematics official audio", "Little Simz Gorilla official audio", "Run the Jewels Legend Has It official audio", "MF DOOM Rhymes Like Dimes official audio", "J Dilla Workinonit official audio"),
    "electronic": ("Four Tet Two Thousand and Seventeen official audio", "Boards of Canada Roygbiv official audio", "Jon Hopkins Open Eye Signal official audio", "Bicep Glue official audio", "The Avalanches Since I Left You official audio"),
    "reggae-ska": ("Desmond Dekker Israelites official audio", "Lee Scratch Perry Roast Fish and Cornbread official audio", "Steel Pulse Steppin Out official audio", "Madness One Step Beyond official audio", "Hepcat No Worries official audio"),
    "progressive": ("Genesis Dance on a Volcano official audio", "Jethro Tull Songs from the Wood official audio", "Steven Wilson Luminol official audio", "Haken Cockroach King official audio", "The Mars Volta L'Via L'Viaquez official audio"),
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
    " cover version",
    " cover by",
    "(cover",
    "[cover",
    "live at",
    "live from",
    " live @",
    " | live",
    " - live",
    " live in ",
    " live on ",
    "(live",
    "[live",
    "concert",
    "rehearsal",
    "soundcheck",
    " demo",
    "acoustic",
    "unplugged",
    "remix",
    "slowed",
    "sped up",
    "nightcore",
    "performance",
    " performs ",
    " performing ",
    "session version",
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


def youtube_challenge_seed(genre: str) -> dict[str, str]:
    try:
        lane_roll = randbelow(10)
        if lane_roll < 4:
            lane, pool = "familiar", YOUTUBE_CHALLENGE_QUERIES[genre]
        elif lane_roll < 8:
            lane, pool = "discovery", YOUTUBE_DISCOVERY_QUERIES[genre]
        else:
            lane, pool = "deep-cut", YOUTUBE_DEEP_CUT_QUERIES[genre]
        return {"query": choice(pool), "lane": lane}
    except KeyError:
        raise KeyError(genre) from None


def youtube_challenge_query(genre: str) -> str:
    return youtube_challenge_seed(genre)["query"]


def youtube_challenge_hand(genre: str, excluded: set[str] | None = None) -> list[dict[str, str]]:
    """Deal five balanced seeds: two familiar, two discoveries, one deep cut."""
    try:
        lanes = (
            ("familiar", YOUTUBE_CHALLENGE_QUERIES[genre], 2),
            ("discovery", YOUTUBE_DISCOVERY_QUERIES[genre] + YOUTUBE_EXTRA_QUERIES[genre], 2),
            ("deep-cut", YOUTUBE_DEEP_CUT_QUERIES[genre], 1),
        )
    except KeyError:
        raise KeyError(genre) from None
    excluded = excluded or set()
    hand = []
    leftovers = []
    for lane, pool, count in lanes:
        available = [query for query in pool if challenge_song_key({"title": query}) not in excluded]
        take = min(count, len(available))
        for _ in range(take):
            query = choice(available)
            available.remove(query)
            hand.append({"query": query, "lane": lane})
        leftovers.extend({"query": query, "lane": lane} for query in available)
    while leftovers and len(hand) < 5:
        seed = choice(leftovers)
        leftovers.remove(seed)
        hand.append(seed)
    if len(hand) < 5:
        # The exact-song bag has genuinely cycled; begin it again.
        return youtube_challenge_hand(genre)
    return sorted(hand, key=lambda _: randbelow(1_000_000))


def is_original_song_result(result: dict) -> bool:
    title = str(result.get("title") or "").casefold()
    return not any(term in title for term in NON_ORIGINAL_RESULT_TERMS)


def challenge_song_key(result: dict) -> str:
    title = str(result.get("title") or "").casefold()
    title = re.sub(r"[\[(].*?[\])]", " ", title)
    title = re.sub(
        r"\b(?:official|music|audio|video|lyrics?|remaster(?:ed)?|hd|hq|vevo)\b",
        " ", title,
    )
    return re.sub(r"[^a-z0-9]+", "-", title).strip("-")[:140]


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


def draw_tracks(
    tracks: list[Track], genre: str, eligible_ids: set[str] | None = None,
    count: int = 5, excluded_ids: set[str] | None = None,
) -> list[Track]:
    pool = [
        track for track in tracks
        if genre in track_genres(track)
        and (eligible_ids is None or track.id in eligible_ids)
        and (excluded_ids is None or track.id not in excluded_ids)
    ]
    if genre not in GENRES:
        raise KeyError(genre)
    if not pool:
        raise LookupError(genre)
    chosen = []
    while pool and len(chosen) < count:
        track = choice(pool)
        pool.remove(track)
        chosen.append(track)
    return chosen


def draw_challenge() -> dict:
    return dict(choice(CHALLENGES))
