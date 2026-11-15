import { createContext, useContext } from "react";

/** Where a status bar's figures come from: the page, the right-hand split, or the drawer. */
export type StatusScope = "main" | "split" | "drawer";

/** The scope components render in. */
export const StatusScopeContext = createContext<StatusScope>("main");

/** The scope last used (clicked or focused), whose figures the status bar shows. */
export const ActiveStatusContext = createContext<{
	active: StatusScope;
	setActive: (scope: StatusScope) => void;
}>({ active: "main", setActive: () => undefined });

/** Where autosaving forms put "Saving…" and "Saved" in the status bar. */
export const SaveSlotContext = createContext<HTMLElement | null>(null);

/** Marks an area as a status scope: using it makes its figures the ones shown. */
export function useStatusScopeHandlers(scope: StatusScope) {
	const { setActive } = useContext(ActiveStatusContext);
	const use = () => setActive(scope);
	return { onPointerDownCapture: use, onFocusCapture: use };
}
