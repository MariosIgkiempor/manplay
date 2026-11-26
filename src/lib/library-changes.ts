import type { LibraryChange } from "#/lib/api.ts";

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
		default:
			return change.name || "Unnamed";
	}
}

/** What a sync did to one item, as short facts in the order they matter. */
export function changeFacts(change: LibraryChange): string[] {
	if (change.kind === "analysis") {
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
