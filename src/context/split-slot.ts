import { createContext, useContext } from "react";

/**
 * Where a page puts a second pane of its own (the Files page's split): a place in the window's
 * row of cards, right of the page's card, so the pane gets a card of its own.
 */
export const SplitSlotContext = createContext<HTMLElement | null>(null);

export const useSplitSlot = () => useContext(SplitSlotContext);
