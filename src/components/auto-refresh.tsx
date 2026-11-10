import { useEffect } from "react";
import { useScan } from "#/lib/queries.ts";

// Module-level so React StrictMode's double effect (and remounts) cannot trigger two launches.
let launched = false;

/** Rescans the remembered library folder and re-syncs once per app launch. Renders nothing. */
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
