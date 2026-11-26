import type { FileRemoval, LibraryChange } from "#/lib/api.ts";

function songs(n: number): string {
	return n === 1 ? "1 song" : `${n.toLocaleString()} songs`;
}

/** What a change is about: the item's name, or what the songs' data is called. */
export function changeTitle(change: LibraryChange): string {
	switch (change.kind) {
		case "analysis":
			return "BPM, key and beat grids";
		case "tag_custom":
			return "Tag Database values";
		case "song_tags":
			return "Tags in the songs' files";
		case "covers":
			return "Covers";
		case "songs_moved":
			return "Songs moved or renamed";
		case "songs_added":
			return "Songs added";
		default:
			return change.name || "Unnamed";
	}
}

/** The changes that are about the songs as a whole and say how many. */
const COUNTED_IN_SONGS: ReadonlySet<LibraryChange["kind"]> = new Set([
	"analysis",
	"song_tags",
	"covers",
	"songs_moved",
	"songs_added",
]);

/** What a sync did to one item, as short facts in the order they matter. */
export function changeFacts(change: LibraryChange): string[] {
	if (COUNTED_IN_SONGS.has(change.kind)) {
		return [songs(change.count)];
	}
	if (change.kind === "tag_custom") {
		return [change.count === 1 ? "1 value" : `${change.count.toLocaleString()} values`];
	}
	const facts: [applies: boolean, text: string][] = [
		[change.standing === "deleted", "Deleted"],
		[change.standing === "restored", "Restored"],
		[change.standing === "created", "New"],
		[change.mergedInto !== null, `Merged into ${change.mergedInto}`],
		[change.renamedFrom !== null, `Renamed from ${change.renamedFrom}`],
		[change.rulesChanged, "Rules changed"],
		[change.songsAdded > 0, `${songs(change.songsAdded)} added`],
		[change.songsRemoved > 0, `${songs(change.songsRemoved)} removed`],
		[change.songsMoved > 0, `${songs(change.songsMoved)} moved`],
	];
	return facts.filter(([applies]) => applies).map(([, text]) => text);
}

/** Who made a sync's changes: "studio-mac", "studio-mac and booth", "3 devices". */
export function changedBy(by: readonly string[]): string {
	if (by.length === 0) {
		return "Another device";
	}
	if (by.length <= 2) {
		return by.join(" and ");
	}
	return `${by.length} devices`;
}

/** Who took a set of songs out of the shared library, as far as one name covers them all. */
type RemovedBy =
	| { kind: "here" }
	| { kind: "device"; name: string }
	/** Several devices, or this one and others: each song says who. */
	| { kind: "several" };

export function removedBy(removals: FileRemoval[]): RemovedBy {
	if (removals.every((removal) => removal.here)) {
		return { kind: "here" };
	}
	const names = new Set(removals.map((removal) => removal.by));
	const [name] = names;
	return names.size === 1 && name !== undefined && removals.every((removal) => !removal.here)
		? { kind: "device", name }
		: { kind: "several" };
}

/** The heading over songs that wait to be kept or removed: who took them out, and how many. */
export function removalsTitle(removals: FileRemoval[]): string {
	const count = songs(removals.length);
	const by = removedBy(removals);
	switch (by.kind) {
		case "here":
			return `You took back ${count} another device added`;
		case "device":
			return `${by.name} removed ${count}`;
		case "several":
			return `${count} removed from the shared library`;
	}
}

/** Who removed one song, for a line of its own. */
export function removalBy(removal: FileRemoval): string {
	return removal.here ? "taken back here" : removal.by;
}
