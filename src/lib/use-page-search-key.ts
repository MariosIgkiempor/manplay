import { useEffect } from "react";

/**
 * ⌘F (Ctrl+F on Windows) puts the cursor in the open page's own search field, the first input
 * marked `data-page-search`. Pages without one leave the key alone.
 */
export function usePageSearchKey() {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f")) {
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
