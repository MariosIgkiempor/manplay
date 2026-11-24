import { type KeyboardEvent, useEffect, useRef } from "react";
import { useDetailNav } from "#/context/detail-context.ts";
import { type PlayerApi, usePlayer } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";
import { typingKey } from "#/lib/keyboard.ts";
import { DOUBLE_PRESS_MS, isListMove, type ListMove, moveIndex } from "#/lib/list-keys.ts";
import { onRevealTrack } from "#/lib/reveal-playing.ts";
import type { ShortcutId } from "#/lib/shortcuts.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";
import { shortcutFor } from "#/lib/use-shortcuts.ts";
import type { TrackSelection } from "#/lib/use-track-selection.ts";

/** What a song list knows when a key is pressed in it. */
interface ListState {
	tracks: readonly Track[];
	selection: TrackSelection | undefined;
	/** Rows drawn so far; they come a page at a time as the list scrolls. */
	shownCount: number;
	more: boolean;
	loadMore: () => void;
	/** Draws rows until row `index` is among them. */
	showUpTo: (index: number) => void;
	/** Library songs open in the side panel; songs elsewhere (a USB drive) do not. */
	canOpen: boolean;
}

const PLAIN = { shiftKey: false, metaKey: false, ctrlKey: false } as const;
const SHIFT = { shiftKey: true, metaKey: false, ctrlKey: false } as const;

const extendsSelection = (move: ListMove) => move === "listExtendNext" || move === "listExtendPrev";

/** With Shift, the selection grows from the cursor's row to the row it moves to. */
function extendSelection(selection: TrackSelection, from: Track | undefined, to: Track) {
	if (selection.selected.size === 0 && from) {
		selection.click(from.id, PLAIN);
	}
	selection.click(to.id, SHIFT);
}

/** The songs a key acts on: the selection when the cursor's row is in it, else that row. */
function songsAt(state: ListState, track: Track): readonly Track[] {
	const { tracks, selection } = state;
	return selection?.selected.has(track.id) && selection.selected.size > 1
		? tracks.filter((t) => selection.selected.has(t.id))
		: [track];
}

type Go = ReturnType<typeof useDetailNav>;
type Action = { when: boolean; run: () => void };

/** Play next, add to the queue, and edit metadata: keys that act on the songs at the cursor. */
function songActions(state: ListState, track: Track, player: PlayerApi, go: Go) {
	const songs = songsAt(state, track);
	const [only] = songs;
	const target = tagTargetFor(songs);
	const edit = () => {
		if (songs.length === 1 && only) {
			go({ kind: "song", trackId: only.id, list: state.tracks.map((t) => t.id) });
		} else if (target) {
			go({ kind: "edit", target });
		}
	};
	return {
		listPlayNext: { when: true, run: () => player.playNext(songs) },
		listQueue: { when: true, run: () => player.addToQueue(songs) },
		listEdit: { when: state.canOpen, run: edit },
	} satisfies Partial<Record<ShortcutId, Action>>;
}

/**
 * Runs a list key that is not a move, on row `at`. False when it does nothing here, so the key
 * goes on: Escape with nothing selected still closes the side panel.
 */
function runAction(id: ShortcutId, at: number, state: ListState, player: PlayerApi, go: Go) {
	const { tracks, selection } = state;
	const track = tracks[at];
	const ids = () => tracks.map((t) => t.id);
	const actions: Partial<Record<ShortcutId, Action>> = {
		...(track && songActions(state, track, player, go)),
		listPlay: { when: track !== undefined, run: () => player.play(tracks, at) },
		listOpen: {
			when: state.canOpen && track !== undefined,
			run: () => track && go({ kind: "song", trackId: track.id, list: ids() }),
		},
		listSelect: {
			when: selection !== undefined && track !== undefined,
			run: () => track && selection?.toggle(track.id),
		},
		listSelectAll: { when: selection !== undefined, run: () => selection?.selectAll() },
		listClear: {
			when: selection !== undefined && selection.selected.size > 0,
			run: () => selection?.clear(),
		},
	};
	const action = actions[id];
	if (!action?.when) {
		return false;
	}
	action.run();
	return true;
}

/**
 * A focused song list's keys (`list` shortcuts, Vim's at first): J and K or the arrows move the
 * cursor, with Shift to select as it goes; gg and G go to the ends; Enter or O plays; L or →
 * opens the song in the side panel; Space or X selects; Escape clears; P plays next, ⇧P
 * queues, ⌘E edits metadata. Every other key is left
 * to the app, so its keys (E, A, /) work here too. Put `listRef` and `onKeyDown` on the listbox.
 */
export function useListKeys(state: ListState) {
	const player = usePlayer();
	const go = useDetailNav();
	const listRef = useRef<HTMLDivElement>(null);
	const lastG = useRef(0);
	const latest = useRef(state);
	latest.current = state;

	const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
	const focusRow = (i: number) => {
		const row = rows()[i];
		row?.focus();
		row?.scrollIntoView({ block: "nearest" });
	};

	/** g alone waits for a second g, as in Vim; true once the pair is complete. */
	const secondG = () => {
		const now = performance.now();
		const double = now - lastG.current < DOUBLE_PRESS_MS;
		lastG.current = double ? 0 : now;
		return double;
	};

	const move = (id: ListMove, at: number) => {
		const { tracks, selection, shownCount, more, loadMore } = latest.current;
		if (id === "listLast" && more) {
			// The last song is further on than the rows drawn: draw more, then go to the end.
			loadMore();
			requestAnimationFrame(() => focusRow(rows().length - 1));
			return;
		}
		const to = moveIndex(id, at, shownCount) ?? -1;
		const target = tracks[to];
		if (target === undefined) {
			return;
		}
		if (to >= shownCount - 1 && more) {
			loadMore();
		}
		if (extendsSelection(id) && selection) {
			extendSelection(selection, tracks[at], target);
		}
		focusRow(to);
	};

	/** Runs the key's action; false when it is not one of the list's here. */
	const run = (id: ShortcutId, e: KeyboardEvent): boolean => {
		const at = rows().findIndex((row) => row.contains(document.activeElement));
		if (id === "listFirst" && e.code === "KeyG") {
			if (secondG()) {
				focusRow(0);
			}
			return true;
		}
		if (isListMove(id)) {
			move(id, at);
			return true;
		}
		return runAction(id, at, latest.current, player, go);
	};

	// The app's "find the playing song" key: draw rows down to the song, then put the cursor on it.
	useEffect(
		() =>
			onRevealTrack({
				has: (trackId) => latest.current.tracks.some((t) => t.id === trackId),
				inPage: () => listRef.current?.closest("main") != null,
				reveal: (trackId) => {
					const index = latest.current.tracks.findIndex((t) => t.id === trackId);
					latest.current.showUpTo(index);
					requestAnimationFrame(() => {
						const row = listRef.current?.querySelectorAll<HTMLElement>("[role=option]")[index];
						row?.focus();
						row?.scrollIntoView({ block: "center" });
					});
				},
			}),
		[],
	);

	const onKeyDown = (e: KeyboardEvent) => {
		const id = typingKey(e.nativeEvent) ? undefined : shortcutFor(e.nativeEvent, "list")?.id;
		if (id !== undefined && !e.defaultPrevented && run(id, e)) {
			e.preventDefault();
		}
	};

	return { listRef, onKeyDown };
}
