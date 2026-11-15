import { type ComponentType, createContext, type ReactNode, useCallback, useContext } from "react";
import type { TagTarget } from "#/components/tag-editor.tsx";
import type { ServiceId } from "#/lib/api.ts";

/** Kinds of export destination. */
export type DestinationService = "tailscale" | "r2" | "rekordbox" | "usb";

export type DetailView =
	| { kind: "album"; key: string }
	| { kind: "artist"; name: string }
	/** Tag editor for library songs. `fromAlbum` reopens that album (by its new name) on close. */
	| { kind: "edit"; target: TagTarget; fromAlbum?: boolean }
	| { kind: "service"; service: ServiceId }
	/** One Tailscale or R2 export destination. */
	| { kind: "target"; id: number }
	/** A plugged-in CDJ USB drive and the rekordbox library on it. */
	| { kind: "usb"; mount: string }
	/** The beat grid editor for one song; `list` is the songs it steps through, in order. */
	| { kind: "grid"; trackId: number; list?: readonly number[] | undefined }
	/** Adding an export destination; without `service`, the step that picks one. */
	| { kind: "add-destination"; service?: DestinationService }
	/** Songs holding one value of a tag field, e.g. every song in the genre "House". */
	| { kind: "value"; field: string; value: string };

export interface DetailApi {
	view: DetailView | null;
	canGoBack: boolean;
	/** Open the panel fresh, discarding any history. */
	open: (view: DetailView) => void;
	/** Navigate deeper from inside the panel, keeping back-history. */
	push: (view: DetailView) => void;
	/** Swap the current view for another, keeping the history behind it. */
	replace: (view: DetailView) => void;
	back: () => void;
	close: () => void;
	/** Wraps the panel's content so its unsaved changes are saved or confirmed on leaving. */
	UnsavedScope: ComponentType<{ children: ReactNode }>;
}

export const DetailContext = createContext<DetailApi | null>(null);

/** Element at the bottom edge of the current view where track lists pin their status bar. */
export const StatusSlotContext = createContext<HTMLElement | null>(null);

/** True for components rendered inside the slide-over panel. */
export const PanelScopeContext = createContext(false);

export function useDetail(): DetailApi {
	const ctx = useContext(DetailContext);
	if (ctx === null) {
		throw new Error("useDetail must be used inside <DetailProvider>");
	}
	return ctx;
}

/** Navigation that pushes inside the panel and opens fresh from the main page. */
export function useDetailNav(): (view: DetailView) => void {
	const { open, push } = useDetail();
	const inPanel = useContext(PanelScopeContext);
	return useCallback((view) => (inPanel ? push(view) : open(view)), [inPanel, open, push]);
}
