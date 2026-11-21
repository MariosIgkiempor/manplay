import type { UndoEntry } from "#/context/undo-context.ts";
import {
	addToPlaylist,
	deletePlaylist,
	type PreviousCover,
	removeFromPlaylist,
	type TagPreview,
	tagsRestoreCovers,
	tagsWriteMany,
	tagTracks,
	untagTrack,
} from "#/lib/api.ts";
import { bumpArt } from "#/lib/art-version.ts";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Puts back the tag values a write replaced, song by song. `null` when nothing changed. */
export function undoTagWrite(before: TagPreview): UndoEntry | null {
	if (before.files.length === 0) {
		return null;
	}
	const items = before.files.map((f) => ({
		path: f.path,
		edits: Object.fromEntries(f.changes.map((c) => [c.field, c.from ?? ""])),
	}));
	return {
		label: `Metadata edit on ${count(items.length, "song", "songs")}`,
		run: async () => {
			const report = await tagsWriteMany(items);
			if (report.failed.length > 0) {
				throw new Error(report.failed[0]?.error ?? "write failed");
			}
		},
	};
}

/** Puts back the covers a cover change replaced. `null` when no song was rewritten. */
export function undoCoverChange(previous: readonly PreviousCover[]): UndoEntry | null {
	if (previous.length === 0) {
		return null;
	}
	return {
		label: `Cover change on ${count(previous.length, "song", "songs")}`,
		run: async () => {
			const report = await tagsRestoreCovers(previous);
			bumpArt();
			if (report.failed.length > 0) {
				throw new Error(report.failed[0]?.error ?? "could not restore the cover");
			}
		},
	};
}

/** Takes `trackIds` back out of a playlist, or deletes the playlist if the add created it. */
export function undoAddToPlaylist(
	playlistId: number,
	name: string,
	trackIds: number[],
	created: boolean,
): UndoEntry | null {
	if (trackIds.length === 0) {
		return null;
	}
	return {
		label: `Add ${count(trackIds.length, "song", "songs")} to “${name}”`,
		run: async () => {
			if (created) {
				await deletePlaylist(playlistId);
				return;
			}
			for (const id of trackIds) {
				await removeFromPlaylist(playlistId, id);
			}
		},
	};
}

/** Adds a removed song back to the playlist (it lands at the end). */
export function undoRemoveFromPlaylist(
	playlistId: number,
	name: string,
	trackId: number,
): UndoEntry {
	return {
		label: `Remove from “${name}”`,
		run: () => addToPlaylist(playlistId, [trackId]),
	};
}

/** Removes a library tag from the songs it was just applied to. */
export function undoTagTracks(name: string, trackIds: number[]): UndoEntry | null {
	if (trackIds.length === 0) {
		return null;
	}
	return {
		label: `Tag “${name}” on ${count(trackIds.length, "song", "songs")}`,
		run: async () => {
			for (const id of trackIds) {
				await untagTrack(name, id);
			}
		},
	};
}

export function undoUntag(name: string, trackId: number): UndoEntry {
	return { label: `Remove tag “${name}”`, run: () => tagTracks(name, [trackId]) };
}
