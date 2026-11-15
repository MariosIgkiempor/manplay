import { useEffect } from "react";
import { useScan } from "#/lib/queries.ts";

// Module-level so React StrictMode's double effect (and remounts) cannot trigger two launches.
let launched = false;

/**
 * Rescans the remembered library folder once per app launch so the library matches the disk.
 * Only reads files; it imports, exports and syncs nothing. Renders nothing.
 */
export function AutoRefresh() {
	const { mutate } = useScan();
	useEffect(() => {
		if (launched) {
			return;
		}
		launched = true;
		mutate("saved");
	}, [mutate]);
	return null;
}
