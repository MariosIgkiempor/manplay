import { type ComponentType, createContext, type ReactNode, useCallback, useContext } from "react";
import type { TagTarget } from "#/components/tag-editor.tsx";

/** The two tabs of a song's view. */
export type SongTab = "grid" | "metadata";

/** What the side panel shows, with history behind it. */
export type DetailView =
	/** A song: its grid and cues or its metadata; `list` is the songs the grid steps through. */
	| { kind: "song"; trackId: number; tab?: SongTab; list?: readonly number[] | undefined }
	| { kind: "album"; key: string }
	| { kind: "artist"; name: string }
	/** Tag editor for several songs (a selection or a value's songs). */
	| { kind: "edit"; target: TagTarget }
	/** Songs holding one value of a tag field, e.g. every song in the genre "House". */
	| { kind: "value"; field: string; value: string }
	/** The library's problems, from the status bar: files gone from disk, files breaking the
	 * library's conventions, and songs stored twice. */
	| { kind: "missing" }
	| { kind: "issues" }
	| { kind: "duplicates" };

/** The side panel's navigation: the view on show and the history behind it. */
export interface DetailApi {
	view: DetailView | null;
	/** The view shown most recently, kept after the panel closes, so it can open there again. */
	last: DetailView | null;
	canGoBack: boolean;
	back: () => void;
	close: () => void;
	/** Wraps the panel's content so its unsaved changes are saved or confirmed on leaving. */
	UnsavedScope: ComponentType<{ children: ReactNode }>;
	/** Show a view fresh in the panel, discarding its history. */
	open: (view: DetailView) => void;
	/** Navigate deeper from inside the panel, keeping back-history. */
	push: (view: DetailView) => void;
	/** Swap the current view of the panel for another, keeping the history behind it. */
	replace: (view: DetailView) => void;
}

export const DetailContext = createContext<DetailApi | null>(null);

/** Element at the bottom edge of the current view where track lists pin their status bar. */
export const StatusSlotContext = createContext<HTMLElement | null>(null);

/** True for components rendered inside the side panel. */
export const PanelScopeContext = createContext(false);

export function useDetail(): DetailApi {
	const ctx = useContext(DetailContext);
	if (ctx === null) {
		throw new Error("useDetail must be used inside <DetailProvider>");
	}
	return ctx;
}

/** Navigation that pushes inside the panel, and opens fresh from the main page. */
export function useDetailNav(): (view: DetailView) => void {
	const { open, push } = useDetail();
	const inPanel = useContext(PanelScopeContext);
	return useCallback((view) => (inPanel ? push(view) : open(view)), [inPanel, open, push]);
}
