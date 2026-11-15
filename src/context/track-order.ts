import { createContext } from "react";

/**
 * Ids of the songs in the list being shown, in the order shown. The grid editor steps through
 * them when opened from that list.
 */
export const TrackOrderContext = createContext<readonly number[] | null>(null);
