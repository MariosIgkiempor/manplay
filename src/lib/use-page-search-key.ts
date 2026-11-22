import { useEffect } from "react";
import { isShortcut } from "#/lib/use-shortcuts.ts";

/**
 * ⌘F (Ctrl+F on Windows, or the key chosen in Settings) puts the cursor in the open page's own search field, the first input
 * marked `data-page-search`. Pages without one leave the key alone.
 */
export function usePageSearchKey() {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!isShortcut(e, "pageSearch")) {
				return;
			}
			const field = document.querySelector<HTMLInputElement>("main [data-page-search]");
			if (field) {
				e.preventDefault();
				field.focus();
				field.select();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
