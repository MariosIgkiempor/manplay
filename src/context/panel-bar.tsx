import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** The side panel's top bar: places its content puts a title and buttons into. */
export interface PanelBarSlots {
	title: HTMLElement | null;
	actions: HTMLElement | null;
}

export const PanelBarContext = createContext<PanelBarSlots | null>(null);

/** Whether the content is in a panel whose top bar takes a title and buttons. */
export const useHasPanelBar = () => useContext(PanelBarContext) !== null;

/** Shows its children as the panel's title, in the top bar beside Back and Close. */
export function PanelBarTitle({ children }: { children: ReactNode }) {
	const slot = useContext(PanelBarContext)?.title;
	return slot ? createPortal(children, slot) : null;
}

/** Shows its children in the panel's top bar, just before Close. */
export function PanelBarActions({ children }: { children: ReactNode }) {
	const slot = useContext(PanelBarContext)?.actions;
	return slot ? createPortal(children, slot) : null;
}
