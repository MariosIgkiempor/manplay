import { describe, expect, it } from "vitest";
import type { RemoteFile, SyncAction } from "#/lib/api.ts";
import {
	chooseAll,
	type IncomingAction,
	ignoreAlbum,
	isIncoming,
	isPicked,
	isPush,
	isSettled,
	onlyThere,
	type PushAction,
	type SyncDirection,
	type ThereChoice,
} from "#/lib/sync-choices.ts";

const action = (kind: SyncAction["kind"], merge: SyncAction["merge"] = null) =>
	({ id: 1, kind, merge }) as SyncAction;

describe("incoming actions", () => {
	it("tells what comes into the library from what goes to the destination", () => {
		expect(["update", "merge", "conflict"].map((k) => isIncoming(action(k as never)))).toEqual([
			true,
			true,
			true,
		]);
		expect(isPush(action("replace"))).toBe(true);
		expect(isIncoming(action("upload"))).toBe(false);
	});

	it("runs an update as is", () => {
		expect(isSettled(action("update") as IncomingAction, undefined)).toBe(true);
	});

	it("needs a copy chosen for a conflict", () => {
		const a = action("conflict") as IncomingAction;
		expect(isSettled(a, undefined)).toBe(false);
		expect(isSettled(a, { keep: "theirs", fields: {} })).toBe(true);
	});

	it("needs every clashing field of a merge settled", () => {
		const merge = [
			{ field: "genre", base: "a", mine: "b", theirs: "c", side: null },
			{ field: "year", base: "1", mine: "1", theirs: "2", side: "theirs" as const },
		];
		const a = action("merge", merge) as IncomingAction;
		expect(isSettled(a, undefined)).toBe(false);
		expect(isSettled(a, { fields: { genre: "mine" } })).toBe(true);
	});
});

const file = (rel: string, otherFormat: string | null = null): RemoteFile => ({
	rel: rel.split("/"),
	size: 10,
	otherFormat,
});

const remove = (id: number, rel: string, optional: boolean, note: string | null): PushAction => ({
	id,
	targetId: 1,
	kind: "delete",
	rel: rel.split("/"),
	from: null,
	size: 10,
	remoteSize: null,
	note,
	optional,
	tags: null,
	localSize: null,
	merge: null,
	trackId: null,
	duplicateOf: null,
});

describe("onlyThere", () => {
	it.each<{
		name: string;
		missing: RemoteFile[];
		actions: PushAction[];
		direction: SyncDirection;
		expected: { key: string; canPull: boolean; canRemove: boolean; suggested: ThereChoice }[];
	}>([
		{
			name: "new audio on the destination is copied here",
			missing: [file("a/new.mp3")],
			actions: [remove(1, "a/new.mp3", true, null)],
			direction: "both",
			expected: [{ key: "a/new.mp3", canPull: true, canRemove: true, suggested: "pull" }],
		},
		{
			name: "a song removed from the library is deleted there",
			missing: [file("a/gone.mp3")],
			actions: [remove(1, "a/gone.mp3", false, "Removed from your library")],
			direction: "both",
			expected: [{ key: "a/gone.mp3", canPull: true, canRemove: true, suggested: "delete" }],
		},
		{
			name: "a song in the library in another format is left",
			missing: [file("a/song.mp3", "flac")],
			actions: [],
			direction: "both",
			expected: [{ key: "a/song.mp3", canPull: true, canRemove: false, suggested: "leave" }],
		},
		{
			name: "a file that is not audio can only be deleted, and is left",
			missing: [],
			actions: [remove(1, "a/cover.jpg", true, null)],
			direction: "both",
			expected: [{ key: "a/cover.jpg", canPull: false, canRemove: true, suggested: "leave" }],
		},
		{
			name: "a duplicate of a library song is left",
			missing: [],
			actions: [remove(1, "b/copy.mp3", true, "Duplicate of song.mp3")],
			direction: "both",
			expected: [{ key: "b/copy.mp3", canPull: false, canRemove: true, suggested: "leave" }],
		},
		{
			name: "pull only never suggests a delete",
			missing: [file("a/gone.mp3")],
			actions: [remove(1, "a/gone.mp3", false, "Removed from your library")],
			direction: "pull",
			expected: [{ key: "a/gone.mp3", canPull: true, canRemove: true, suggested: "leave" }],
		},
		{
			name: "push only never suggests a copy here",
			missing: [file("a/new.mp3")],
			actions: [],
			direction: "push",
			expected: [{ key: "a/new.mp3", canPull: true, canRemove: false, suggested: "leave" }],
		},
	])("$name", ({ missing, actions, direction, expected }) => {
		expect(
			onlyThere(missing, actions, direction).map((f) => ({
				key: f.key,
				canPull: f.pull !== null,
				canRemove: f.remove !== null,
				suggested: f.suggested,
			})),
		).toEqual(expected);
	});
});

describe("chooseAll", () => {
	const files = onlyThere(
		[file("a/new.mp3")],
		[remove(1, "a/new.mp3", true, null), remove(2, "a/cover.jpg", true, null)],
		"both",
	);
	it.each<{ name: string; choice: ThereChoice | null; expected: [string, ThereChoice][] }>([
		{
			name: "copy here skips files that cannot be copied",
			choice: "pull",
			expected: [
				["7:a/new.mp3", "pull"],
				["7:other", "leave"],
			],
		},
		{
			name: "delete there applies to every removable file",
			choice: "delete",
			expected: [
				["7:a/cover.jpg", "delete"],
				["7:a/new.mp3", "delete"],
				["7:other", "leave"],
			],
		},
		{
			name: "leave applies to every file",
			choice: "leave",
			expected: [
				["7:a/cover.jpg", "leave"],
				["7:a/new.mp3", "leave"],
				["7:other", "leave"],
			],
		},
		{
			name: "suggested forgets this destination's choices",
			choice: null,
			expected: [["7:other", "leave"]],
		},
	])("$name", ({ choice, expected }) => {
		const current = new Map<string, ThereChoice>([
			["7:a/new.mp3", "leave"],
			["7:other", "leave"],
		]);
		const out = [...chooseAll(current, 7, files, choice)].sort(([a], [b]) => a.localeCompare(b));
		expect(out).toEqual(expected);
	});
});

describe("isPicked", () => {
	const act = (kind: SyncAction["kind"], optional = false) =>
		({ id: 1, kind, optional, merge: null }) as SyncAction;
	it.each<{
		name: string;
		a: SyncAction;
		direction: SyncDirection;
		flipped: boolean;
		keep?: "mine" | "theirs";
		expected: boolean;
	}>([
		{
			name: "an upload starts ticked",
			a: act("upload"),
			direction: "both",
			flipped: false,
			expected: true,
		},
		{
			name: "an opt-in replace starts unticked",
			a: act("replace", true),
			direction: "both",
			flipped: false,
			expected: false,
		},
		{
			name: "unticking an upload",
			a: act("upload"),
			direction: "both",
			flipped: true,
			expected: false,
		},
		{
			name: "pull only leaves uploads unticked",
			a: act("upload"),
			direction: "pull",
			flipped: false,
			expected: false,
		},
		{
			name: "an update starts ticked",
			a: act("update"),
			direction: "both",
			flipped: false,
			expected: true,
		},
		{
			name: "push only leaves updates unticked",
			a: act("update"),
			direction: "push",
			flipped: false,
			expected: false,
		},
		{
			name: "a conflict waits for a choice",
			a: act("conflict"),
			direction: "both",
			flipped: false,
			expected: false,
		},
		{
			name: "a chosen conflict runs",
			a: act("conflict"),
			direction: "both",
			flipped: false,
			keep: "mine",
			expected: true,
		},
	])("$name", ({ a, direction, flipped, keep, expected }) => {
		const choice = keep ? { keep, fields: {} } : undefined;
		expect(isPicked(a, direction, flipped, choice)).toBe(expected);
	});
});

describe("ignoreAlbum", () => {
	const at = (path: string) => ({ rel: path.split("/") });
	it.each([
		{
			name: "one folder for an album's files",
			files: ["A/Live/01.flac", "A/Live/02.flac"],
			rules: [{ rel: ["A", "Live"], scope: "folder" }],
		},
		{
			name: "each disc folder of a multi-disc album",
			files: ["A/Live/CD1/01.flac", "A/Live/CD2/01.flac"],
			rules: [
				{ rel: ["A", "Live", "CD1"], scope: "folder" },
				{ rel: ["A", "Live", "CD2"], scope: "folder" },
			],
		},
		{
			name: "a file at the top on its own",
			files: ["loose.mp3", "A/Live/01.flac"],
			rules: [
				{ rel: ["loose.mp3"], scope: "file" },
				{ rel: ["A", "Live"], scope: "folder" },
			],
		},
		{ name: "nothing for no files", files: [], rules: [] },
	])("$name", ({ files, rules }) => {
		expect(ignoreAlbum(files.map(at))).toEqual(rules);
	});
});
