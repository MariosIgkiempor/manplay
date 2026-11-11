import { useEffect } from "react";
import { useItunesImport, useScan } from "#/lib/queries.ts";

// Module-level so React StrictMode's double effect (and remounts) cannot trigger two launches.
let launched = false;

/**
 * Rescans the remembered library folder, then imports new iTunes songs (if configured) and
 * re-syncs, once per app launch. Renders nothing.
 */
export function AutoRefresh() {
	const { mutate } = useScan();
	const itunes = useItunesImport();
	const importItunes = itunes.mutate;
	useEffect(() => {
		if (launched) {
			return;
		}
		launched = true;
		mutate("saved", { onSuccess: () => importItunes() });
	}, [mutate, importItunes]);
	return null;
}
