import type { Resolution, SyncAction, TargetPlan } from "#/lib/api.ts";
import { isAudioName } from "#/lib/fs-path.ts";
import {
	type IncomingAction,
	isSettled,
	type PushAction,
	type SyncDirection,
	type ThereChoice,
	type ThereFile,
	thereOptions,
} from "#/lib/sync-choices.ts";

/** A library file the push puts on the destination: new, changed or moved. */
export type SendAction = PushAction & { kind: "upload" | "replace" | "move" };

export const isSend = (a: PushAction): a is SendAction => a.kind !== "delete";

/** One file of a destination's review, whichever way it goes. */
export type ReviewItem =
	| { side: "send"; action: SendAction }
	| { side: "bring"; action: IncomingAction }
	| { side: "there"; file: ThereFile };

/** Says what each destination-only file is set to. */
export type ThereLookup = (f: ThereFile) => ThereChoice;

/** Unique within one destination's review. */
export type ItemKey = string & { readonly __brand: "ItemKey" };

export const itemKey = (i: ReviewItem): ItemKey =>
	(i.side === "there" ? `there:${i.file.key}` : `action:${i.action.id}`) as ItemKey;

/** Where the file is on the destination after the sync (a move's new path). */
export const relOf = (i: ReviewItem): readonly string[] =>
	i.side === "there" ? i.file.rel : i.action.rel;

export const nameOf = (i: ReviewItem): string => relOf(i).at(-1) ?? "";

/** The library song a file is, when the plan knows it. */
export const trackIdOf = (i: ReviewItem): number | null =>
	i.side === "there" ? (i.file.remove?.trackId ?? null) : i.action.trackId;

/** Files that are not songs, and duplicates of library songs: they go in "Other files". */
export const isOtherFile = (i: ReviewItem): boolean =>
	!isAudioName(nameOf(i)) || (i.side === "there" && (i.file.remove?.duplicateOf ?? null) !== null);

/** Every file of a destination's review, sends first, then edits there, then only there. */
export function reviewItems(
	send: readonly SendAction[],
	incoming: readonly IncomingAction[],
	there: readonly ThereFile[],
): ReviewItem[] {
	return [
		...send.map((action): ReviewItem => ({ side: "send", action })),
		...incoming.map((action): ReviewItem => ({ side: "bring", action })),
		...there.map((file): ReviewItem => ({ side: "there", file })),
	];
}

/**
 * The review's sections: what goes to the destination, what comes into the library, and files
 * only on the destination, which can go either way.
 */
export type Lane = ReviewItem["side"];

export const LANES: readonly Lane[] = ["send", "bring", "there"];

/** The review's files split by section, in the order they came. */
export function itemsByLane(items: readonly ReviewItem[]): Record<Lane, ReviewItem[]> {
	const lanes: Record<Lane, ReviewItem[]> = { send: [], bring: [], there: [] };
	for (const item of items) {
		lanes[item.side].push(item);
	}
	return lanes;
}

/** The section a one-way sync starts folded: the direction it leaves out. */
export function foldedLane(direction: SyncDirection): Lane | null {
	if (direction === "push") {
		return "bring";
	}
	return direction === "pull" ? "send" : null;
}

/**
 * The sign before a file: ↑ changes the destination, ↓ changes the library, ⇄ needs a choice.
 * Coloured like the tallies.
 */
export function signOf(
	item: ReviewItem,
	there: ThereLookup,
): { sign: string; tone: ChangeTone | null } {
	if (item.side === "there") {
		const c = there(item.file);
		if (c === "pull") {
			return { sign: "↓", tone: "add" };
		}
		return c === "delete" ? { sign: "↑", tone: "remove" } : { sign: "·", tone: null };
	}
	return ACTION_SIGN[item.action.kind];
}

const ACTION_SIGN: Record<
	(SendAction | IncomingAction)["kind"],
	{ sign: string; tone: ChangeTone }
> = {
	upload: { sign: "↑", tone: "add" },
	replace: { sign: "↑", tone: "change" },
	move: { sign: "↑", tone: "move" },
	update: { sign: "↓", tone: "change" },
	merge: { sign: "⇄", tone: "change" },
	conflict: { sign: "⇄", tone: "remove" },
};

/**
 * Changes a select-all box covers: sends, and edits there that are settled. A conflict is only
 * ticked by choosing a copy, so it is never ticked in bulk.
 */
export function tickable(
	items: readonly ReviewItem[],
	choiceOf: (a: IncomingAction) => Resolution | undefined,
): SyncAction[] {
	return items.flatMap((i): SyncAction[] => {
		if (i.side === "send") {
			return [i.action];
		}
		if (
			i.side === "bring" &&
			i.action.kind !== "conflict" &&
			isSettled(i.action, choiceOf(i.action))
		) {
			return [i.action];
		}
		return [];
	});
}

// ---- Albums ---------------------------------------------------------------

/** What the library knows of a song's album. */
export interface AlbumInfo {
	album: string;
	artist: string;
}

/** Finds a library song's album by track id; undefined when the song is not in the library. */
export type TrackLookup = (trackId: number) => AlbumInfo | undefined;

export type AlbumKey = string & { readonly __brand: "AlbumKey" };

export const OTHER_FILES = "other" as AlbumKey;

/** One album's files in the review. */
export interface AlbumGroup {
	key: AlbumKey;
	album: string;
	artist: string;
	/** A library song whose artwork stands for the album, when any of its files is one. */
	coverTrackId: number | null;
	/** The "Other files" group: not songs, or duplicates. */
	other: boolean;
	items: ReviewItem[];
}

/** A file's album and artist from its path, `Artist/Album/file`, for files the library lacks. */
export const albumFromPath = (rel: readonly string[]): AlbumInfo => ({
	album: rel.length >= 2 ? (rel.at(-2) ?? "") : "",
	artist: rel.length >= 3 ? (rel.at(-3) ?? "") : "",
});

const fold = (s: string) => s.normalize("NFC").trim().toLowerCase();
const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Where one file belongs in the album view. */
function albumOf(
	item: ReviewItem,
	lookup: TrackLookup,
): { key: AlbumKey; info: AlbumInfo; coverId: number | null } {
	if (isOtherFile(item)) {
		return { key: OTHER_FILES, info: { album: "", artist: "" }, coverId: null };
	}
	const id = trackIdOf(item);
	const known = id === null ? undefined : lookup(id);
	const info = known ?? albumFromPath(relOf(item));
	return {
		key: `${fold(info.artist)}\u0001${fold(info.album)}` as AlbumKey,
		info,
		coverId: known ? id : null,
	};
}

/**
 * Groups the review's files by album: the library's tags where the file is a library song, else
 * its folders. Albums are sorted by artist then album, with "Other files" last.
 */
export function groupByAlbum(items: readonly ReviewItem[], lookup: TrackLookup): AlbumGroup[] {
	const groups = new Map<AlbumKey, AlbumGroup>();
	for (const item of items) {
		const { key, info, coverId } = albumOf(item, lookup);
		const group = groups.get(key) ?? {
			key,
			...info,
			coverTrackId: null,
			other: key === OTHER_FILES,
			items: [],
		};
		groups.set(key, group);
		if (coverId !== null && group.coverTrackId === null) {
			// The library's spelling wins over a folder name.
			Object.assign(group, info, { coverTrackId: coverId });
		}
		group.items.push(item);
	}
	return [...groups.values()].sort((a, b) => {
		if (a.other !== b.other) {
			return a.other ? 1 : -1;
		}
		return compare(a.artist, b.artist) || compare(a.album, b.album);
	});
}

/** One kind of count on an album card. */
export type ChipKind =
	| "new"
	| "retagged"
	| "changed"
	| "moved"
	| "editedThere"
	| "bothEdited"
	| "copyHere"
	| "deleteThere"
	| "left";

export const CHIP_ORDER: readonly ChipKind[] = [
	"new",
	"retagged",
	"changed",
	"moved",
	"editedThere",
	"bothEdited",
	"copyHere",
	"deleteThere",
	"left",
];

const THERE_CHIP: Record<ThereChoice, ChipKind> = {
	pull: "copyHere",
	delete: "deleteThere",
	leave: "left",
};

/** What happens to one file, as an album card counts it. */
export function chipOf(item: ReviewItem, there: ThereLookup): ChipKind {
	if (item.side === "there") {
		return THERE_CHIP[there(item.file)];
	}
	const a = item.action;
	switch (a.kind) {
		case "upload":
			return "new";
		case "replace":
			return (a.tags?.length ?? 0) > 0 ? "retagged" : "changed";
		case "move":
			return "moved";
		case "update":
			return "editedThere";
		default:
			return "bothEdited";
	}
}

/** One count on an album card: how many files of a kind, and how many of them will run. */
export interface AlbumChip {
	kind: ChipKind;
	count: number;
	ticked: number;
}

/**
 * How many files of each kind an album holds and how many are ticked, in a fixed order, leaving
 * out kinds it lacks. A file only on the destination counts as ticked unless it is left alone.
 */
export function albumChips(
	items: readonly ReviewItem[],
	there: ThereLookup,
	picked: (a: SyncAction) => boolean,
): AlbumChip[] {
	const chips = new Map<ChipKind, AlbumChip>();
	for (const item of items) {
		const kind = chipOf(item, there);
		const chip = chips.get(kind) ?? { kind, count: 0, ticked: 0 };
		chip.count += 1;
		const runs = item.side === "there" ? there(item.file) !== "leave" : picked(item.action);
		if (runs) {
			chip.ticked += 1;
		}
		chips.set(kind, chip);
	}
	return CHIP_ORDER.flatMap((kind) => {
		const chip = chips.get(kind);
		return chip ? [chip] : [];
	});
}

/** One choice that covers every destination-only file of an album. */
export interface SharedThere {
	files: ThereFile[];
	options: ThereChoice[];
	/** What every file is set to, or null when they differ. */
	value: ThereChoice | null;
}

/**
 * The album-wide choice, when every destination-only file of the album allows the same choices;
 * null when there are none or they differ.
 */
export function sharedThere(items: readonly ReviewItem[], there: ThereLookup): SharedThere | null {
	const files = items.flatMap((i) => (i.side === "there" ? [i.file] : []));
	const first = files[0];
	if (first === undefined) {
		return null;
	}
	const options = thereOptions(first);
	const same = (f: ThereFile) => thereOptions(f).join() === options.join();
	if (!files.every(same)) {
		return null;
	}
	const value = there(first);
	return { files, options, value: files.every((f) => there(f) === value) ? value : null };
}

/** Marks the element whose end a lifted card may hang past: the whole review, not one lane. */
export const REVIEW_END_ATTRIBUTE = "data-review-end";

/** Height of one row of the album mosaic, in pixels. */
export const MOSAIC_ROW_PX = 88;

/** The narrowest an open album's file list may be beside its card, and the widest. */
export const FLOAT_PANEL_MIN_PX = 320;
export const FLOAT_PANEL_MAX_PX = 720;

/** Where an open album's file list goes: beside its card, or under it when neither side fits. */
export type FloatSide = "right" | "left" | "below";

export interface FloatPlacement {
	side: FloatSide;
	/** Width of the file list in pixels; under the card it is as wide as the card. */
	panel: number;
}

/**
 * Where an open album floats its file list, given the card's place in the mosaic. The card
 * stays where it is; the list goes on its right, or on its left when the card is too close to
 * the right edge, and is about two cards wide where there is room.
 */
export function floatPlacement(
	cardLeft: number,
	cardWidth: number,
	gridWidth: number,
): FloatPlacement {
	const wanted = Math.min(FLOAT_PANEL_MAX_PX, Math.max(FLOAT_PANEL_MIN_PX, cardWidth * 2));
	const right = gridWidth - cardLeft - cardWidth;
	if (right >= FLOAT_PANEL_MIN_PX) {
		return { side: "right", panel: Math.min(wanted, right) };
	}
	if (cardLeft >= FLOAT_PANEL_MIN_PX) {
		return { side: "left", panel: Math.min(wanted, cardLeft) };
	}
	return { side: "below", panel: cardWidth };
}

// ---- Folders --------------------------------------------------------------

/** Signed counts of what a sync does under a folder. */
export interface FolderTally {
	add: number;
	change: number;
	move: number;
	remove: number;
}

/** Which way a change goes, coloured the same everywhere: add, change, move or remove. */
export type ChangeTone = keyof FolderTally;

export const TALLY_TONES: readonly ChangeTone[] = ["add", "change", "move", "remove"];

/** A file in the after-sync tree. A ghost is a moved file at the path it leaves. */
export type TreeEntry =
	| { item: ReviewItem; ghost: false }
	| { item: ReviewItem & { side: "send" }; ghost: true };

export interface TreeFolder {
	name: string;
	/** Its path on the destination, joined with `/`; the root is "". */
	path: string;
	folders: TreeFolder[];
	entries: TreeEntry[];
	/** Rolled up from everything below. */
	tally: FolderTally;
	/** Files directly in it that the sync leaves as they are. */
	unchanged: number;
	/** Something below it is in the review. */
	busy: boolean;
}

/** Which way the tally counts one file. Files left alone count nowhere. */
export function toneOf(item: ReviewItem, there: ThereLookup): ChangeTone | null {
	if (item.side === "there") {
		const c = there(item.file);
		if (c === "leave") {
			return null;
		}
		return c === "pull" ? "add" : "remove";
	}
	switch (item.action.kind) {
		case "upload":
			return "add";
		case "move":
			return "move";
		default:
			return "change";
	}
}

/** Where the file is on the destination now, if it is there yet. */
function currentRel(item: ReviewItem): readonly string[] | null {
	if (item.side === "there") {
		return item.file.rel;
	}
	const a = item.action;
	if (a.kind === "upload") {
		return null;
	}
	return a.kind === "move" ? a.from : a.rel;
}

const dirKey = (rel: readonly string[]) => rel.slice(0, -1).join("/");

/** The name a tree entry shows: a ghost shows the name it had before the move. */
const entryName = (e: TreeEntry): string =>
	e.ghost ? (e.item.action.from?.at(-1) ?? "") : nameOf(e.item);

function tallyOf(
	kids: readonly TreeFolder[],
	entries: readonly TreeEntry[],
	there: ThereLookup,
): FolderTally {
	const tally: FolderTally = { add: 0, change: 0, move: 0, remove: 0 };
	for (const k of kids) {
		for (const tone of TALLY_TONES) {
			tally[tone] += k.tally[tone];
		}
	}
	for (const e of entries) {
		const tone = e.ghost ? null : toneOf(e.item, there);
		if (tone) {
			tally[tone] += 1;
		}
	}
	return tally;
}

interface Draft {
	name: string;
	path: string;
	kids: Map<string, Draft>;
	entries: TreeEntry[];
}

/**
 * The destination's folders as they will be after the sync. A moved file shows at its new path
 * and as a ghost at its old one. Folders with nothing in the review are left out unless
 * `showUnchanged`; `folders` (from the plan) supplies them and the unchanged counts.
 */
export function buildTree(
	items: readonly ReviewItem[],
	folders: TargetPlan["folders"],
	there: ThereLookup,
	showUnchanged: boolean,
): TreeFolder {
	const root: Draft = { name: "", path: "", kids: new Map(), entries: [] };
	const at = (dir: readonly string[]) =>
		dir.reduce((node, part) => {
			let next = node.kids.get(part);
			if (!next) {
				next = {
					name: part,
					path: node.path ? `${node.path}/${part}` : part,
					kids: new Map(),
					entries: [],
				};
				node.kids.set(part, next);
			}
			return next;
		}, root);
	for (const item of items) {
		at(relOf(item).slice(0, -1)).entries.push({ item, ghost: false });
		if (item.side === "send" && item.action.kind === "move" && item.action.from) {
			at(item.action.from.slice(0, -1)).entries.push({ item, ghost: true });
		}
	}
	const files = new Map<string, number>();
	for (const f of folders) {
		files.set(f.rel.join("/"), f.files);
		if (showUnchanged) {
			at(f.rel);
		}
	}
	const touched = new Map<string, number>();
	for (const item of items) {
		const rel = currentRel(item);
		if (rel) {
			const k = dirKey(rel);
			touched.set(k, (touched.get(k) ?? 0) + 1);
		}
	}
	const finish = (d: Draft): TreeFolder => {
		const kids = [...d.kids.values()]
			.map(finish)
			.filter((k) => k.busy || showUnchanged)
			.sort((a, b) => compare(a.name, b.name));
		return {
			name: d.name,
			path: d.path,
			folders: kids,
			entries: d.entries.toSorted((a, b) => compare(entryName(a), entryName(b))),
			tally: tallyOf(kids, d.entries, there),
			unchanged: Math.max(0, (files.get(d.path) ?? 0) - (touched.get(d.path) ?? 0)),
			busy: d.entries.length > 0 || kids.some((k) => k.busy),
		};
	};
	return finish(root);
}

/** One line of the tree as shown: a folder, a file, or how many files a folder leaves alone. */
export type TreeRow =
	| { type: "folder"; folder: TreeFolder; depth: number; open: boolean }
	| { type: "entry"; entry: TreeEntry; depth: number }
	| { type: "unchanged"; path: string; count: number; depth: number };

/** Every review item in a folder and below. */
export const itemsUnder = (f: TreeFolder): ReviewItem[] => [
	...f.entries.flatMap((e) => (e.ghost ? [] : [e.item])),
	...f.folders.flatMap(itemsUnder),
];

/**
 * The tree's lines top to bottom: each folder, then (unless `closed`) its subfolders and files.
 * With `showUnchanged`, a folder's files left alone are counted after its own files.
 */
export function treeRows(
	root: TreeFolder,
	closed: ReadonlySet<string>,
	showUnchanged: boolean,
): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (f: TreeFolder, depth: number) => {
		for (const folder of f.folders) {
			const open = !closed.has(folder.path);
			rows.push({ type: "folder", folder, depth, open });
			if (open) {
				walk(folder, depth + 1);
			}
		}
		for (const entry of f.entries) {
			rows.push({ type: "entry", entry, depth });
		}
		if (showUnchanged && f.unchanged > 0) {
			rows.push({ type: "unchanged", path: f.path, count: f.unchanged, depth });
		}
	};
	walk(root, 0);
	return rows;
}
