import { type ComponentType, createContext, type ReactNode, useCallback, useContext } from "react";
import type { TagTarget } from "#/components/tag-editor.tsx";
import type { ServiceId } from "#/lib/api.ts";

/** Kinds of export destination. */
export type DestinationService = "tailscale" | "r2" | "rekordbox" | "usb";

/** The two tabs of a song's view. */
export type SongTab = "grid" | "metadata";

/** What the left split shows: one song, album or artist, with history behind it. */
export type SplitView =
	/** A song: its grid and cues or its metadata; `list` is the songs the grid steps through. */
	| { kind: "song"; trackId: number; tab?: SongTab; list?: readonly number[] | undefined }
	| { kind: "album"; key: string }
	| { kind: "artist"; name: string };

/** What the right-hand drawer shows. */
export type DrawerView =
	/** Tag editor for several songs (a selection or a value's songs). */
	| { kind: "edit"; target: TagTarget }
	| { kind: "service"; service: ServiceId }
	/** One Tailscale or R2 export destination. */
	| { kind: "target"; id: number }
	/** A plugged-in CDJ USB drive and the rekordbox library on it. */
	| { kind: "usb"; mount: string }
	/** Adding an export destination; without `service`, the step that picks one. */
	| { kind: "add-destination"; service?: DestinationService }
	/** Songs holding one value of a tag field, e.g. every song in the genre "House". */
	| { kind: "value"; field: string; value: string };

export type DetailView = SplitView | DrawerView;

const SPLIT_KINDS = new Set<string>(["song", "album", "artist"]);

export function isSplitView(view: DetailView): view is SplitView {
	return SPLIT_KINDS.has(view.kind);
}

/** One pane's navigation: the view on show and the history behind it. */
export interface PaneApi<V> {
	view: V | null;
	canGoBack: boolean;
	back: () => void;
	close: () => void;
	/** Wraps the pane's content so its unsaved changes are saved or confirmed on leaving. */
	UnsavedScope: ComponentType<{ children: ReactNode }>;
}

export interface DetailApi extends PaneApi<DrawerView> {
	/** The left split, which holds songs, albums and artists. */
	split: PaneApi<SplitView>;
	/** Show a view fresh in its pane (split or drawer), discarding that pane's history. */
	open: (view: DetailView) => void;
	/** Navigate deeper from inside a pane, keeping back-history. */
	push: (view: DetailView) => void;
	/** Swap the current view of its pane for another, keeping the history behind it. */
	replace: (view: DetailView) => void;
}

export const DetailContext = createContext<DetailApi | null>(null);

/** Element at the bottom edge of the current view where track lists pin their status bar. */
export const StatusSlotContext = createContext<HTMLElement | null>(null);

/** True for components rendered inside the slide-over drawer or the left split. */
export const PanelScopeContext = createContext(false);

/** True for components rendered inside the left split. */
export const SplitScopeContext = createContext(false);

export function useDetail(): DetailApi {
	const ctx = useContext(DetailContext);
	if (ctx === null) {
		throw new Error("useDetail must be used inside <DetailProvider>");
	}
	return ctx;
}

/**
 * Navigation that pushes inside the pane the view belongs to, and opens fresh from anywhere else
 * (the main page, or the other pane).
 */
export function useDetailNav(): (view: DetailView) => void {
	const { open, push } = useDetail();
	const inPanel = useContext(PanelScopeContext);
	const inSplit = useContext(SplitScopeContext);
	return useCallback(
		(view) => {
			const here = isSplitView(view) ? inSplit : inPanel && !inSplit;
			return here ? push(view) : open(view);
		},
		[inPanel, inSplit, open, push],
	);
}
