import { useEffect } from "react";
import { openPalette } from "#/lib/open-palette.ts";
import { appKeyRunsHere, isShortcut } from "#/lib/use-shortcuts.ts";

/**
 * ⌘F or / (Ctrl+F on Windows, or the keys chosen in Settings) puts the cursor in the open page's
 * own search field, the first input marked `data-page-search`. A page without one opens Search
 * everything instead, so the key always finds something. The file browser keeps / for its own
 * filter while it has focus.
 */
export function usePageSearchKey() {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isShortcut(e, "pageSearch") || !appKeyRunsHere(e, "pageSearch")) {
				return;
			}
			e.preventDefault();
			const field = document.querySelector<HTMLInputElement>("main [data-page-search]");
			if (field) {
				field.focus();
				field.select();
			} else {
				openPalette();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
