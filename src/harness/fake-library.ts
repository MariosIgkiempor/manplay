import type { Playlist, SmartPlaylist, Tag, Track, TrackAnalysis } from "#/lib/api.ts";

/** The made-up library the harness serves: the same songs on every run, so screenshots compare. */
export const LIBRARY_ROOT = "/Users/dj/Music/Library";

/** Seconds since the epoch, taken once so every "3 days ago" on a page agrees. */
export const NOW = Math.floor(Date.now() / 1000);
export const DAY = 86_400;

/** A small repeatable random source (mulberry32). */
export function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export function hashText(text: string): number {
	let hash = 2_166_136_261;
	for (const char of text) {
		hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16_777_619);
	}
	return hash >>> 0;
}

interface AlbumSpec {
	artist: string;
	album: string;
	year: number;
	genre: string;
	label: string;
	songs: number;
	bpm: readonly [number, number];
	tags: readonly string[];
}

const ALBUMS: readonly AlbumSpec[] = [
	{
		artist: "Mira Solène",
		album: "Glasshouse",
		year: 2024,
		genre: "Deep House",
		label: "Low Tide Records",
		songs: 9,
		bpm: [118, 124],
		tags: ["Genre/House/Deep", "Energy/Warm-up"],
	},
	{
		artist: "Mira Solène",
		album: "Night Swim EP",
		year: 2022,
		genre: "Deep House",
		label: "Low Tide Records",
		songs: 4,
		bpm: [120, 123],
		tags: ["Genre/House/Deep"],
	},
	{
		artist: "Kaito Brandt",
		album: "Concrete Bloom",
		year: 2023,
		genre: "Techno",
		label: "Halde Tonträger",
		songs: 8,
		bpm: [128, 136],
		tags: ["Genre/Techno", "Energy/Peak"],
	},
	{
		artist: "Kaito Brandt",
		album: "Signal Loss",
		year: 2021,
		genre: "Techno",
		label: "Halde Tonträger",
		songs: 6,
		bpm: [130, 138],
		tags: ["Genre/Techno/Hypnotic"],
	},
	{
		artist: "The Low Tide Collective",
		album: "Everything Returns to the Shoreline Eventually (Deluxe Edition)",
		year: 2020,
		genre: "Downtempo",
		label: "Low Tide Records",
		songs: 11,
		bpm: [88, 104],
		tags: ["Genre/Downtempo", "Energy/Warm-up"],
	},
	{
		artist: "Odessa Vale",
		album: "Paper Lanterns",
		year: 2025,
		genre: "House",
		label: "Sundial",
		songs: 7,
		bpm: [122, 126],
		tags: ["Genre/House", "Vocal"],
	},
	{
		artist: "Juniper & Rye",
		album: "Slow Motion Disco",
		year: 2019,
		genre: "Disco",
		label: "Mirrorball Editions",
		songs: 8,
		bpm: [110, 120],
		tags: ["Genre/Disco", "Vocal", "Sets/Rooftop"],
	},
	{
		artist: "Halden",
		album: "Fjordlight",
		year: 2023,
		genre: "Progressive House",
		label: "Nordkap",
		songs: 6,
		bpm: [122, 126],
		tags: ["Genre/House/Progressive", "Energy/Build"],
	},
	{
		artist: "Nuit Blanche",
		album: "Après Minuit",
		year: 2024,
		genre: "Tech House",
		label: "Sundial",
		songs: 7,
		bpm: [125, 129],
		tags: ["Genre/House/Tech", "Energy/Peak", "Sets/Friday"],
	},
	{
		artist: "Costa Meridian",
		album: "Balearic Letters",
		year: 2018,
		genre: "Balearic",
		label: "Mirrorball Editions",
		songs: 9,
		bpm: [100, 116],
		tags: ["Genre/Balearic", "Sets/Rooftop"],
	},
	{
		artist: "DJ Parallax",
		album: "Breaks From the Basement",
		year: 2022,
		genre: "Breakbeat",
		label: "Sub Level",
		songs: 6,
		bpm: [130, 140],
		tags: ["Genre/Breaks", "Energy/Peak"],
	},
	{
		artist: "Sable Ferro",
		album: "Iron Garden",
		year: 2025,
		genre: "Drum & Bass",
		label: "Sub Level",
		songs: 8,
		bpm: [170, 176],
		tags: ["Genre/Drum & Bass", "Energy/Peak"],
	},
	{
		artist: "Wren Okafor",
		album: "Soft Machines",
		year: 2021,
		genre: "Electronica",
		label: "Nordkap",
		songs: 10,
		bpm: [96, 128],
		tags: ["Genre/Electronica"],
	},
	{
		artist: "Atlas Motel",
		album: "Vacancy",
		year: 2017,
		genre: "Nu Disco",
		label: "Mirrorball Editions",
		songs: 5,
		bpm: [112, 122],
		tags: ["Genre/Disco/Nu", "Vocal"],
	},
	{
		artist: "Velvet Circuit",
		album: "Afterimage",
		year: 2024,
		genre: "Melodic Techno",
		label: "Halde Tonträger",
		songs: 7,
		bpm: [122, 126],
		tags: ["Genre/Techno/Melodic", "Energy/Build", "Sets/Friday"],
	},
	{
		artist: "Tomas Reyerson",
		album: "Singles",
		year: 2025,
		genre: "House",
		label: "",
		songs: 3,
		bpm: [124, 126],
		tags: [],
	},
];

const TITLE_STARTS = [
	"Midnight",
	"Paper",
	"Velvet",
	"Hollow",
	"Golden",
	"Distant",
	"Neon",
	"Quiet",
	"Saltwater",
	"Electric",
	"Borrowed",
	"Second",
	"Low",
	"Silver",
	"Open",
	"Falling",
] as const;
const TITLE_ENDS = [
	"Hours",
	"Signal",
	"Garden",
	"Machine",
	"Letters",
	"Weather",
	"Motion",
	"Rooms",
	"Arcade",
	"Current",
	"Harbour",
	"Static",
	"Mirrors",
	"Avenue",
	"Tide",
	"Circuit",
] as const;
const TITLE_SUFFIXES = [
	"",
	"",
	"",
	"",
	" (Original Mix)",
	" (Extended Mix)",
	" (Dub)",
	" (feat. Odessa Vale)",
	" (Kaito Brandt Remix)",
] as const;
const KEYS = [
	"Am",
	"Em",
	"Bm",
	"F#m",
	"C#m",
	"G#m",
	"Ebm",
	"Bbm",
	"Fm",
	"Cm",
	"Gm",
	"Dm",
	"C",
	"G",
	"D",
	"A",
	"E",
	"F",
] as const;

function pick<T>(items: readonly T[], random: () => number): T {
	return items[Math.floor(random() * items.length)] as T;
}

function songTitle(random: () => number): string {
	return `${pick(TITLE_STARTS, random)} ${pick(TITLE_ENDS, random)}${pick(TITLE_SUFFIXES, random)}`;
}

function buildTrack(spec: AlbumSpec, position: number, id: number, random: () => number): Track {
	const title = songTitle(random);
	const durationMs = Math.round((180 + random() * 260) * 1000);
	const bitrate = random() < 0.85 ? 320 : 256;
	const analyzed = id % 17 !== 0;
	const bpm = analyzed ? Math.round(spec.bpm[0] + random() * (spec.bpm[1] - spec.bpm[0])) : null;
	const number = String(position + 1).padStart(2, "0");
	const fields: Record<string, string> = {
		year: String(spec.year),
		genre: spec.genre,
		artist: spec.artist,
		albumArtist: spec.artist,
		...(spec.label === "" ? {} : { label: spec.label }),
	};
	return {
		id,
		path: `${LIBRARY_ROOT}/${spec.artist}/${spec.album}/${number} ${title}.mp3`,
		artist: spec.artist,
		album: spec.album,
		title,
		size: Math.round((durationMs / 1000) * bitrate * 125),
		tags: position % 5 === 4 ? [] : [...spec.tags],
		syncedCount: id % 9 === 0 ? 0 : id % 4 === 0 ? 1 : 2,
		durationMs,
		bitrate,
		sampleRate: 44_100,
		bpm,
		key: analyzed ? pick(KEYS, random) : null,
		analyzed,
		fields,
		edited: { bpm: id % 23 === 0, key: false, grid: id % 31 === 0 },
		fileState: "here",
		addedAt: id % 29 === 0 ? null : NOW - Math.floor(random() * 400) * DAY,
	};
}

/**
 * The library's songs. `copies` above 1 repeats every album under further artist names
 * ("Mira Solène 2", ...), for a library the size of a real collection.
 */
export function buildTracks(copies = 1): Track[] {
	const random = seededRandom(7);
	const tracks: Track[] = [];
	for (let copy = 1; copy <= copies; copy += 1) {
		for (const album of ALBUMS) {
			const spec = copy === 1 ? album : { ...album, artist: `${album.artist} ${copy}` };
			for (let position = 0; position < spec.songs; position += 1) {
				tracks.push(buildTrack(spec, position, tracks.length + 1, random));
			}
		}
	}
	return tracks;
}

const LOCAL_TAGS = new Set(["Sets/Friday"]);

/** Every tag a song carries, plus one nobody uses yet. */
export function buildTags(tracks: readonly Track[]): Tag[] {
	const counts = new Map<string, number>([["Energy/Cool-down", 0]]);
	for (const track of tracks) {
		for (const tag of track.tags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts].map(([name, trackCount], index) => ({
		id: index + 1,
		name,
		trackCount,
		scope: LOCAL_TAGS.has(name) ? "local" : "shared",
	}));
}

export interface FakePlaylist {
	playlist: Playlist;
	trackIds: number[];
}

export function buildPlaylists(tracks: readonly Track[]): FakePlaylist[] {
	const everyNth = (step: number, offset: number, limit: number) =>
		tracks
			.filter((track) => track.id % step === offset)
			.slice(0, limit)
			.map((track) => track.id);
	const specs: { name: string; trackIds: number[]; scope: "shared" | "local" }[] = [
		{ name: "Friday Warm-up", trackIds: everyNth(5, 1, 18), scope: "shared" },
		{ name: "Peak Time", trackIds: everyNth(4, 2, 24), scope: "shared" },
		{
			name: "Rooftop Sunset — Summer Residency 2026",
			trackIds: everyNth(7, 3, 14),
			scope: "shared",
		},
		{ name: "Closing Tracks", trackIds: everyNth(11, 0, 9), scope: "local" },
		{ name: "To Sort", trackIds: [], scope: "local" },
	];
	return specs.map((spec, index) => ({
		playlist: {
			id: index + 1,
			name: spec.name,
			trackCount: spec.trackIds.length,
			scope: spec.scope,
		},
		trackIds: spec.trackIds,
	}));
}

export function buildSmartPlaylists(): SmartPlaylist[] {
	const none = { allTags: [], anyTags: [], noneTags: [], added: null, bpmMin: null, bpmMax: null };
	return [
		{
			id: 1,
			name: "New This Month",
			rules: { ...none, added: { kind: "within", amount: 30, unit: "days" } },
			scope: "shared",
		},
		{
			id: 2,
			name: "House 120–126",
			rules: { ...none, anyTags: ["Genre/House"], bpmMin: 120, bpmMax: 126 },
			scope: "shared",
		},
		{
			id: 3,
			name: "Peak, no vocals",
			rules: { ...none, allTags: ["Energy/Peak"], noneTags: ["Vocal"] },
			scope: "local",
		},
	];
}

const WAVEFORM_RATE = 150;

/** A waveform with the shape of a dance track: quiet intro, breakdowns, loud drops. */
export function buildAnalysis(track: Track): TrackAnalysis | null {
	if (!track.analyzed || track.durationMs === null) {
		return null;
	}
	const random = seededRandom(track.id * 131);
	const duration = track.durationMs / 1000;
	const columns = Math.floor(duration * WAVEFORM_RATE);
	const beatColumns = (60 / (track.bpm ?? 124)) * WAVEFORM_RATE;
	const detail: number[] = [];
	for (let column = 0; column < columns; column += 1) {
		const place = column / columns;
		const section = Math.floor(place * 12);
		const quiet = section === 0 || section === 5 || section === 11;
		const kick = 1 - ((column % beatColumns) / beatColumns) * 0.55;
		const level = (quiet ? 0.35 : 0.8) * kick + random() * 0.18;
		const height = Math.max(1, Math.min(31, Math.round(level * 31)));
		const whiteness = Math.min(7, Math.round(random() * (quiet ? 3 : 6)));
		detail.push((whiteness << 5) | height);
	}
	return {
		gridBpm: track.bpm,
		firstBeat: 0.12 + (track.id % 5) * 0.03,
		barOffset: 0,
		duration,
		rate: WAVEFORM_RATE,
		detail,
	};
}
