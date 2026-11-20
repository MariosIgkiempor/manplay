import { describe, expect, it } from "vitest";
import type { SyncAction } from "#/lib/api.ts";
import type { IncomingAction, ThereChoice, ThereFile } from "#/lib/sync-choices.ts";
import {
	type AlbumInfo,
	albumChips,
	albumFromPath,
	buildTree,
	type ChipKind,
	floatPlacement,
	groupByAlbum,
	type ReviewItem,
	type SendAction,
	sharedThere,
	type TreeFolder,
	type TreeRow,
	tickable,
	treeRows,
} from "#/lib/sync-review-model.ts";

let nextId = 1;
const action = (kind: SyncAction["kind"], rel: string, extra: Partial<SyncAction> = {}) =>
	({
		id: nextId++,
		targetId: 1,
		kind,
		rel: rel.split("/"),
		from: null,
		size: 10,
		remoteSize: null,
		note: null,
		optional: false,
		tags: null,
		localSize: null,
		merge: null,
		trackId: null,
		duplicateOf: null,
		...extra,
	}) as SyncAction;

const send = (
	kind: SendAction["kind"],
	rel: string,
	extra: Partial<SyncAction> = {},
): ReviewItem => ({
	side: "send",
	action: action(kind, rel, extra) as SendAction,
});
const bring = (kind: IncomingAction["kind"], rel: string): ReviewItem => ({
	side: "bring",
	action: action(kind, rel) as IncomingAction,
});
const there = (
	rel: string,
	can: { pull?: boolean; remove?: boolean; duplicateOf?: number; trackId?: number } = {},
): ReviewItem => {
	const parts = rel.split("/");
	const file: ThereFile = {
		key: rel,
		rel: parts,
		size: 10,
		pull: can.pull ? { rel: parts, size: 10 } : null,
		remove: can.remove
			? (action("delete", rel, {
					duplicateOf: can.duplicateOf ?? null,
					trackId: can.trackId ?? null,
				}) as ThereFile["remove"])
			: null,
		note: null,
		suggested: "leave",
	};
	return { side: "there", file };
};
const suggested = (f: ThereFile): ThereChoice => f.suggested;

const library = new Map<number, AlbumInfo>([
	[1, { album: "Isles", artist: "Bicep" }],
	[2, { album: "Untrue", artist: "Burial" }],
]);
const lookup = (id: number) => library.get(id);

describe("albumFromPath", () => {
	it.each<{ rel: string; expected: AlbumInfo }>([
		{ rel: "Bicep/Isles/03 Atlas.flac", expected: { artist: "Bicep", album: "Isles" } },
		{ rel: "Music/Bicep/Isles/03 Atlas.flac", expected: { artist: "Bicep", album: "Isles" } },
		{ rel: "Isles/03 Atlas.flac", expected: { artist: "", album: "Isles" } },
		{ rel: "03 Atlas.flac", expected: { artist: "", album: "" } },
	])("$rel", ({ rel, expected }) => {
		expect(albumFromPath(rel.split("/"))).toEqual(expected);
	});
});

describe("groupByAlbum", () => {
	it.each<{ name: string; items: ReviewItem[]; expected: [string, string, number][] }>([
		{
			name: "library songs group by their tags, whatever folder they are in",
			items: [send("upload", "a/x.flac", { trackId: 1 }), send("move", "b/y.flac", { trackId: 1 })],
			expected: [["Bicep", "Isles", 2]],
		},
		{
			name: "files the library lacks fall back to Artist/Album folders and join the same album",
			items: [
				send("upload", "a/x.flac", { trackId: 1 }),
				there("bicep/isles/z.flac", { pull: true }),
			],
			expected: [["Bicep", "Isles", 2]],
		},
		{
			name: "files that are not songs and duplicates go in Other files, last",
			items: [
				there("Bicep/Isles/cover.jpg", { remove: true }),
				there("Unsorted/Saku (1).flac", { remove: true, duplicateOf: 1 }),
				send("upload", "Burial/Untrue/a.mp3", { trackId: 2 }),
			],
			expected: [
				["Burial", "Untrue", 1],
				["", "", 2],
			],
		},
		{
			name: "a delete of a song that left the library uses its folders",
			items: [there("Disclosure/Settle/Latch.mp3", { remove: true, trackId: 99 })],
			expected: [["Disclosure", "Settle", 1]],
		},
		{
			name: "albums sort by artist then album",
			items: [send("upload", "x.flac", { trackId: 2 }), send("upload", "y.flac", { trackId: 1 })],
			expected: [
				["Bicep", "Isles", 1],
				["Burial", "Untrue", 1],
			],
		},
	])("$name", ({ items, expected }) => {
		expect(groupByAlbum(items, lookup).map((g) => [g.artist, g.album, g.items.length])).toEqual(
			expected,
		);
	});

	it("takes the cover from a library song of the album", () => {
		const [group] = groupByAlbum(
			[there("Bicep/Isles/z.flac", { pull: true }), send("upload", "a/x.flac", { trackId: 1 })],
			lookup,
		);
		expect(group?.coverTrackId).toBe(1);
	});
});

describe("albumChips", () => {
	it.each<{ name: string; items: ReviewItem[]; expected: [ChipKind, number][] }>([
		{
			name: "counts each kind of change in a fixed order",
			items: [
				bring("conflict", "a.flac"),
				send("upload", "b.flac"),
				send("upload", "c.flac"),
				send("replace", "d.flac", { tags: [{ field: "bpm", from: "1", to: "2" }] }),
				send("replace", "e.flac"),
				send("move", "f.flac"),
				bring("update", "g.flac"),
				bring("merge", "h.flac"),
			],
			expected: [
				["new", 2],
				["retagged", 1],
				["changed", 1],
				["moved", 1],
				["editedThere", 1],
				["bothEdited", 2],
			],
		},
		{
			name: "files only there count by what they are set to",
			items: [there("a.flac", { pull: true }), there("b.flac", { remove: true })],
			expected: [["left", 2]],
		},
	])("$name", ({ items, expected }) => {
		expect(albumChips(items, suggested).map((c) => [c.kind, c.count])).toEqual(expected);
	});
});

describe("sharedThere", () => {
	it.each<{ name: string; items: ReviewItem[]; expected: ThereChoice[] | null }>([
		{
			name: "files that allow the same choices share one",
			items: [
				there("a.mp3", { pull: true, remove: true }),
				there("b.mp3", { pull: true, remove: true }),
				send("upload", "c.mp3"),
			],
			expected: ["pull", "delete", "leave"],
		},
		{
			name: "one file still gets the album-wide choice",
			items: [there("a.mp3", { remove: true })],
			expected: ["delete", "leave"],
		},
		{
			name: "files that allow different choices each keep their own",
			items: [there("a.mp3", { pull: true }), there("b.mp3", { remove: true })],
			expected: null,
		},
		{
			name: "an album with nothing only there has none",
			items: [send("upload", "a.mp3")],
			expected: null,
		},
	])("$name", ({ items, expected }) => {
		expect(sharedThere(items, suggested)?.options ?? null).toEqual(expected);
	});

	it("shows no value while the files are set differently", () => {
		const items = [there("a.mp3", { pull: true }), there("b.mp3", { pull: true })];
		const first = items[0]?.side === "there" ? items[0].file : null;
		expect(sharedThere(items, (f) => (f === first ? "pull" : "leave"))?.value).toBeNull();
		expect(sharedThere(items, () => "pull")?.value).toBe("pull");
	});
});

describe("floatPlacement", () => {
	it.each([
		{
			name: "first column: two cards wide on the right",
			left: 0,
			expected: { side: "right", panel: 480 },
		},
		{
			name: "middle: right, limited by the space left",
			left: 252,
			expected: { side: "right", panel: 456 },
		},
		{ name: "last column: flips to the left", left: 708, expected: { side: "left", panel: 480 } },
		{
			name: "wide cards stop at the widest list",
			left: 0,
			width: 400,
			grid: 1400,
			expected: { side: "right", panel: 720 },
		},
		{
			name: "one column: under the card",
			left: 0,
			width: 300,
			grid: 300,
			expected: { side: "below", panel: 300 },
		},
		{
			name: "neither side wide enough: under the card",
			left: 200,
			width: 240,
			grid: 700,
			expected: { side: "below", panel: 240 },
		},
	])("$name", ({ left, width = 240, grid = 948, expected }) => {
		expect(floatPlacement(left, width, grid)).toEqual(expected);
	});
});

/** The tree as `path [+add ~change →move −remove] unchanged: entries`, one line per folder. */
function outline(f: TreeFolder): string[] {
	const t = f.tally;
	const entries = f.entries.map((e) => `${e.ghost ? "ghost:" : ""}${e.item.side}`).join(",");
	return [
		`${f.path || "/"} [+${t.add} ~${t.change} →${t.move} −${t.remove}] ${f.unchanged}: ${entries}`,
		...f.folders.flatMap(outline),
	];
}

describe("buildTree", () => {
	const folders = [
		{ rel: ["A"], files: 0 },
		{ rel: ["A", "One"], files: 4 },
		{ rel: ["Unsorted"], files: 1 },
		{ rel: ["Quiet"], files: 7 },
	];
	const items = [
		send("upload", "A/One/new.flac"),
		send("replace", "A/One/old.flac"),
		send("move", "A/One/moved.flac", { from: ["Unsorted", "moved.flac"] }),
		there("A/One/extra.flac", { pull: true }),
	];
	it.each<{ name: string; showUnchanged: boolean; expected: string[] }>([
		{
			name: "only folders with changes show, with rolled-up counts and a ghost where a file moved from",
			showUnchanged: false,
			expected: [
				"/ [+2 ~1 →1 −0] 0: ",
				"A [+2 ~1 →1 −0] 0: ",
				"A/One [+2 ~1 →1 −0] 2: there,send,send,send",
				"Unsorted [+0 ~0 →0 −0] 0: ghost:send",
			],
		},
		{
			name: "show unchanged adds the folders the sync leaves alone",
			showUnchanged: true,
			expected: [
				"/ [+2 ~1 →1 −0] 0: ",
				"A [+2 ~1 →1 −0] 0: ",
				"A/One [+2 ~1 →1 −0] 2: there,send,send,send",
				"Quiet [+0 ~0 →0 −0] 7: ",
				"Unsorted [+0 ~0 →0 −0] 0: ghost:send",
			],
		},
	])("$name", ({ showUnchanged, expected }) => {
		expect(outline(buildTree(items, folders, () => "pull", showUnchanged))).toEqual(expected);
	});

	it("counts a file only there by its choice, and a left one nowhere", () => {
		const one = [there("X/a.mp3", { remove: true })];
		expect(buildTree(one, [], () => "delete", false).tally.remove).toBe(1);
		expect(buildTree(one, [], () => "leave", false).tally).toEqual({
			add: 0,
			change: 0,
			move: 0,
			remove: 0,
		});
	});
});

describe("treeRows", () => {
	const items = [
		send("upload", "A/One/new.flac"),
		send("upload", "A/top.flac"),
		send("upload", "B/b.flac"),
	];
	const folders = [{ rel: ["A"], files: 3 }];
	const describeRow = (r: TreeRow) =>
		r.type === "folder"
			? `${r.depth} dir ${r.folder.path}`
			: r.type === "entry"
				? `${r.depth} file ${r.entry.item.side === "send" ? r.entry.item.action.rel.join("/") : ""}`
				: `${r.depth} unchanged ${r.count}`;
	it.each<{ name: string; closed: string[]; showUnchanged: boolean; expected: string[] }>([
		{
			name: "folders come before files, each level deeper",
			closed: [],
			showUnchanged: false,
			expected: [
				"0 dir A",
				"1 dir A/One",
				"2 file A/One/new.flac",
				"1 file A/top.flac",
				"0 dir B",
				"1 file B/b.flac",
			],
		},
		{
			name: "a folded folder hides everything under it",
			closed: ["A"],
			showUnchanged: false,
			expected: ["0 dir A", "0 dir B", "1 file B/b.flac"],
		},
		{
			name: "unchanged files are counted after a folder's own files",
			closed: ["A/One", "B"],
			showUnchanged: true,
			expected: ["0 dir A", "1 dir A/One", "1 file A/top.flac", "1 unchanged 3", "0 dir B"],
		},
	])("$name", ({ closed, showUnchanged, expected }) => {
		const root = buildTree(items, folders, suggested, showUnchanged);
		expect(treeRows(root, new Set(closed), showUnchanged).map(describeRow)).toEqual(expected);
	});
});

describe("tickable", () => {
	it.each<{ name: string; item: ReviewItem; expected: boolean }>([
		{ name: "a send", item: send("upload", "a.flac"), expected: true },
		{ name: "an update", item: bring("update", "a.flac"), expected: true },
		{
			name: "a conflict is ticked only by choosing a copy",
			item: bring("conflict", "a.flac"),
			expected: false,
		},
		{
			name: "a file only there has a choice, not a tick",
			item: there("a.flac", { pull: true }),
			expected: false,
		},
	])("$name", ({ item, expected }) => {
		expect(tickable([item], () => undefined).length > 0).toBe(expected);
	});
});
