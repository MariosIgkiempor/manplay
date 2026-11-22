import {
	FOLDER_NAME_MAX_PARTS,
	FOLDER_NAME_MAX_TEXT,
	FOLDER_NAME_TAGS,
	type FolderFileNames,
	type FolderNamePart,
	type FolderNameTag,
	folderFileNamesSchema,
} from "#/lib/api.ts";

/** What each tag is called in the file name editor. */
export const FOLDER_NAME_TAG_LABELS: Record<FolderNameTag, string> = {
	fileName: "File name",
	title: "Title",
	artist: "Artist",
	album: "Album",
	genre: "Genre",
	key: "Key",
	bpm: "BPM",
	year: "Year",
	trackNumber: "Track no.",
};

/** A song's tags as a file name is made from them. */
export type FolderNameSong = Record<FolderNameTag, string> & { extension: string };

/** The song the editor shows its preview with. */
export const EXAMPLE_SONG: FolderNameSong = {
	fileName: "bicep-glue",
	title: "Glue",
	artist: "Bicep",
	album: "Bicep",
	genre: "Electronic",
	key: "8A",
	bpm: "128",
	year: "2017",
	trackNumber: "03",
	extension: ".mp3",
};

/** Ready-made names to start from. */
export const FOLDER_NAME_PRESETS: readonly { label: string; parts: FolderFileNames }[] = [
	{ label: "File name", parts: [{ tag: "fileName" }] },
	{ label: "Artist - Title", parts: [{ tag: "artist" }, { text: " - " }, { tag: "title" }] },
	{ label: "Title - Artist", parts: [{ tag: "title" }, { text: " - " }, { tag: "artist" }] },
	{
		label: "Key BPM Artist - Title",
		parts: [
			{ tag: "key" },
			{ text: " " },
			{ tag: "bpm" },
			{ text: " " },
			{ tag: "artist" },
			{ text: " - " },
			{ tag: "title" },
		],
	},
];

const UNSAFE = /[/\\:*?"<>|\p{Cc}]/gu;

/**
 * The name a song gets in a playlist folder, as `FileNameTemplate::render` in
 * `playlist_folders/file_name.rs` makes it, so the editor's preview matches the drive. Text next
 * to a tag the song has no value for is left out with it.
 */
export function renderFolderFileName(parts: FolderFileNames, song: FolderNameSong): string {
	const values = parts.map((p) => ("tag" in p ? song[p.tag].trim() : null));
	const filled = (v: string | null | undefined) => v !== undefined && v !== null && v !== "";
	const name = parts
		.map((part: FolderNamePart, i) => {
			if ("tag" in part) {
				return values[i] ?? "";
			}
			const before = values
				.slice(0, i)
				.reverse()
				.find((v) => v !== null);
			const after = values.slice(i + 1).find((v) => v !== null);
			const needed =
				before === undefined && after === undefined
					? true
					: (before === undefined || filled(before)) && (after === undefined || filled(after));
			return needed ? part.text : "";
		})
		.join("")
		.trim();
	const stem = (name === "" ? song.fileName : name)
		.replace(UNSAFE, "_")
		.trim()
		.replace(/[. ]+$/, "");
	return `${stem}${song.extension}`;
}

/** A tag as it is written in the editor's text: `{Artist}`. */
export const tagToken = (tag: FolderNameTag) => `{${FOLDER_NAME_TAG_LABELS[tag]}}`;

/** The tag a token's inside names, by its label or its key, in any case. */
function tagNamed(name: string): FolderNameTag | undefined {
	const wanted = name.trim().toLowerCase();
	return FOLDER_NAME_TAGS.find(
		(tag) => FOLDER_NAME_TAG_LABELS[tag].toLowerCase() === wanted || tag.toLowerCase() === wanted,
	);
}

const TOKEN = /\{([^{}]*)\}/g;

/** The parts as the editor shows them: tags as `{Label}`, text as typed. */
export function formatFolderFileName(parts: FolderFileNames): string {
	return parts.map((p) => ("tag" in p ? tagToken(p.tag) : p.text)).join("");
}

/** Where each tag token sits in the editor's text, for drawing it as a chip. */
export function folderNameTokens(text: string): { start: number; end: number }[] {
	return [...text.matchAll(TOKEN)]
		.filter((m) => tagNamed(m[1] ?? "") !== undefined)
		.map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

export type ParsedFolderFileName =
	| { ok: true; parts: FolderFileNames }
	| { ok: false; error: string };

/** The editor's text read back into parts; braces that name no tag are kept as text. */
export function parseFolderFileName(text: string): ParsedFolderFileName {
	const parts: FolderNamePart[] = [];
	const addText = (piece: string) => {
		if (piece === "") {
			return;
		}
		const last = parts[parts.length - 1];
		if (last && "text" in last) {
			last.text += piece;
		} else {
			parts.push({ text: piece });
		}
	};
	let at = 0;
	for (const m of text.matchAll(TOKEN)) {
		const tag = tagNamed(m[1] ?? "");
		if (tag === undefined) {
			continue;
		}
		addText(text.slice(at, m.index));
		parts.push({ tag });
		at = m.index + m[0].length;
	}
	addText(text.slice(at));
	const checked = folderFileNamesSchema.safeParse(parts);
	if (checked.success) {
		return { ok: true, parts: checked.data };
	}
	return { ok: false, error: folderNameProblem(parts) };
}

function folderNameProblem(parts: FolderNamePart[]): string {
	if (!parts.some((p) => "tag" in p)) {
		return "Add at least one tag.";
	}
	if (parts.length > FOLDER_NAME_MAX_PARTS) {
		return `A name holds ${FOLDER_NAME_MAX_PARTS} tags and texts at most.`;
	}
	return `Text between tags is ${FOLDER_NAME_MAX_TEXT} characters at most.`;
}

/** The tag being typed at `caret`: what follows an unclosed `{`, and where that `{` is. */
export function tagBeingTyped(text: string, caret: number): { from: number; query: string } | null {
	const before = text.slice(0, caret);
	const open = before.lastIndexOf("{");
	if (open === -1 || before.lastIndexOf("}") > open) {
		return null;
	}
	return { from: open, query: before.slice(open + 1) };
}

/** The tags whose label holds `query`, those starting with it first. */
export function tagsMatching(query: string): FolderNameTag[] {
	const q = query.trim().toLowerCase();
	const label = (tag: FolderNameTag) => FOLDER_NAME_TAG_LABELS[tag].toLowerCase();
	return FOLDER_NAME_TAGS.filter((tag) => label(tag).includes(q)).sort(
		(a, b) => Number(!label(a).startsWith(q)) - Number(!label(b).startsWith(q)),
	);
}

/** The token that ends at `caret` or starts there, so one key removes all of it. */
export function tokenAt(
	text: string,
	caret: number,
	side: "before" | "after",
): { start: number; end: number } | undefined {
	return folderNameTokens(text).find((t) => (side === "before" ? t.end : t.start) === caret);
}
