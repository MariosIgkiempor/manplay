import { createContext, useCallback, useContext } from "react";
import type { TagTarget } from "#/components/tag-editor.tsx";
import type { ServiceId } from "#/lib/api.ts";

export type DetailView =
	| { kind: "album"; key: string }
	| { kind: "artist"; name: string }
	| { kind: "tag"; name: string }
	/** Tag editor for library songs. `fromAlbum` reopens that album (by its new name) on close. */
	| { kind: "edit"; target: TagTarget; fromAlbum?: boolean }
	| { kind: "service"; service: ServiceId };

export interface DetailApi {
	view: DetailView | null;
	canGoBack: boolean;
	/** Open the panel fresh, discarding any history. */
	open: (view: DetailView) => void;
	/** Navigate deeper from inside the panel, keeping back-history. */
	push: (view: DetailView) => void;
	back: () => void;
	close: () => void;
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
