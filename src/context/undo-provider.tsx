import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UndoContext, type UndoEntry } from "#/context/undo-context.ts";
import { isShortcut } from "#/lib/use-shortcuts.ts";
import { cn } from "#/lib/utils.ts";

const MAX_ENTRIES = 50;
const REFRESH = [
	"fs",
	"tracks",
	"playlists",
	"playlist-tracks",
	"tags",
	"library-status",
	"audit",
	"tag-values",
	"file-tags",
];

/** App-wide undo stack for file, tag, playlist and library-tag operations; Cmd+Z undoes the last. */
export function UndoProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();
	const stack = useRef<UndoEntry[]>([]);
	const running = useRef(false);
	const [label, setLabel] = useState<string | null>(null);
	const [recorded, setRecorded] = useState(0);
	const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);

	useEffect(() => {
		if (toast === null) {
			return;
		}
		const timer = setTimeout(() => setToast(null), toast.error ? 8000 : 2500);
		return () => clearTimeout(timer);
	}, [toast]);

	const record = useCallback((entry: UndoEntry) => {
		stack.current = [...stack.current, entry].slice(-MAX_ENTRIES);
		setLabel(entry.label);
		setRecorded((n) => n + 1);
	}, []);

	const undo = useCallback(async () => {
		const entry = stack.current.at(-1);
		if (!entry || running.current) {
			return;
		}
		running.current = true;
		try {
			await entry.run();
			stack.current = stack.current.slice(0, -1);
			setToast({ text: `Undid ${entry.label}`, error: false });
		} catch (e) {
			stack.current = [];
			setToast({ text: `Could not undo ${entry.label}: ${String(e)}`, error: true });
		} finally {
			running.current = false;
			setLabel(stack.current.at(-1)?.label ?? null);
			await Promise.all(REFRESH.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
		}
	}, [queryClient]);

	// ⌘Z (or the key chosen in Settings), except while typing (fields keep their own undo) or
	// with a dialog open.
	useEffect(() => {
		const onKey = (ev: KeyboardEvent) => {
			if (!isShortcut(ev, "undo")) {
				return;
			}
			const el = ev.target instanceof HTMLElement ? ev.target : null;
			if (el?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) {
				return;
			}
			ev.preventDefault();
			void undo();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [undo]);

	const api = useMemo(
		() => ({ record, undo, canUndo: label !== null, label, recorded }),
		[record, undo, label, recorded],
	);

	return (
		<UndoContext.Provider value={api}>
			{children}
			{toast && (
				<output
					className={cn(
						"fixed bottom-20 left-1/2 z-50 max-w-lg -translate-x-1/2 animate-in rounded-md border bg-popover px-3 py-2 text-sm shadow-md fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none",
						toast.error && "text-destructive",
					)}
				>
					{toast.text}
				</output>
			)}
		</UndoContext.Provider>
	);
}
