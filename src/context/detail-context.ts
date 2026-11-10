import { createContext, useCallback, useContext } from "react";

export type DetailView =
	| { kind: "album"; key: string }
	| { kind: "artist"; name: string }
	| { kind: "tag"; name: string };

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
