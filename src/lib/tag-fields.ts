/** Editable tag fields, grouped for the editor. Ids match `FIELDS` in `src-tauri/src/tags.rs`. */
export interface TagField {
	id: string;
	label: string;
	/** `file`: only offered when editing a single song. `both`: also when editing a folder. */
	scope: "file" | "both";
	/** Where it matters, shown as a hint. */
	hint?: string;
	kind?: "text" | "number" | "flag";
	suggestions?: readonly string[];
	wide?: boolean;
	/** Offer values already used in the library (a searchable list). */
	pick?: boolean;
	/** Holds several names, stored as `A; B`. */
	multi?: boolean;
}

export interface TagGroup {
	title: string;
	fields: TagField[];
}

export const GENRES = [
	"Ambient",
	"Blues",
	"Breakbeat",
	"Classical",
	"Country",
	"Dance",
	"Deep House",
	"Disco",
	"Drum & Bass",
	"Dubstep",
	"Electronic",
	"Funk",
	"Hip-Hop",
	"House",
	"Jazz",
	"Latin",
	"Metal",
	"Pop",
	"Progressive House",
	"Punk",
	"R&B",
	"Reggae",
	"Rock",
	"Soul",
	"Tech House",
	"Techno",
	"Trance",
] as const;

/** Camelot wheel and musical notation, the two key formats rekordbox reads. */
export const KEYS = [
	...Array.from({ length: 12 }, (_, i) => `${i + 1}A`),
	...Array.from({ length: 12 }, (_, i) => `${i + 1}B`),
	"Am",
	"Bbm",
	"Bm",
	"Cm",
	"C#m",
	"Dm",
	"Ebm",
	"Em",
	"Fm",
	"F#m",
	"Gm",
	"G#m",
	"C",
	"Db",
	"D",
	"Eb",
	"E",
	"F",
	"F#",
	"G",
	"Ab",
	"A",
	"Bb",
	"B",
] as const;

export const TAG_GROUPS: TagGroup[] = [
	{
		title: "Core",
		fields: [
			{ id: "title", label: "Title", scope: "file", wide: true },
			{ id: "subtitle", label: "Mix / subtitle", scope: "file", hint: "rekordbox mix name" },
			{ id: "artist", label: "Artist", scope: "both", wide: true, pick: true, multi: true },
			{
				id: "albumArtist",
				label: "Album artist",
				scope: "both",
				wide: true,
				pick: true,
				multi: true,
				hint: "Jellyfin groups albums by this",
			},
			{ id: "album", label: "Album", scope: "both", wide: true },
			{ id: "year", label: "Year / date", scope: "both" },
			{ id: "genre", label: "Genre", scope: "both", suggestions: GENRES, pick: true, multi: true },
		],
	},
	{
		title: "Numbering",
		fields: [
			{ id: "track", label: "Track", scope: "file", kind: "number" },
			{ id: "trackTotal", label: "Track total", scope: "both", kind: "number" },
			{ id: "disc", label: "Disc", scope: "both", kind: "number" },
			{ id: "discTotal", label: "Disc total", scope: "both", kind: "number" },
			{
				id: "compilation",
				label: "Compilation",
				scope: "both",
				kind: "flag",
				hint: "Various-artists album",
			},
		],
	},
	{
		title: "DJ",
		fields: [
			{ id: "bpm", label: "BPM", scope: "file", kind: "number", hint: "rekordbox" },
			{
				id: "key",
				label: "Key",
				scope: "file",
				suggestions: KEYS,
				hint: "rekordbox",
			},
			{ id: "label", label: "Label", scope: "both", hint: "rekordbox", pick: true },
			{
				id: "remixer",
				label: "Remixer",
				scope: "both",
				hint: "rekordbox",
				pick: true,
				multi: true,
			},
			{ id: "grouping", label: "Grouping", scope: "both", hint: "rekordbox", pick: true },
			{ id: "comment", label: "Comment", scope: "both", wide: true, hint: "rekordbox" },
		],
	},
	{
		title: "Credits",
		fields: [
			{ id: "composer", label: "Composer", scope: "both", pick: true, multi: true },
			{ id: "lyricist", label: "Lyricist", scope: "both" },
			{ id: "conductor", label: "Conductor", scope: "both" },
			{ id: "originalArtist", label: "Original artist", scope: "both" },
		],
	},
	{
		title: "Other",
		fields: [
			{ id: "mood", label: "Mood", scope: "both", pick: true },
			{ id: "language", label: "Language", scope: "both", pick: true },
			{ id: "isrc", label: "ISRC", scope: "file" },
			{ id: "copyright", label: "Copyright", scope: "both" },
		],
	},
	{
		title: "Sort names",
		fields: [
			{ id: "sortTitle", label: "Sort title", scope: "file" },
			{ id: "sortArtist", label: "Sort artist", scope: "both" },
			{ id: "sortAlbum", label: "Sort album", scope: "both" },
			{ id: "sortAlbumArtist", label: "Sort album artist", scope: "both" },
		],
	},
];
