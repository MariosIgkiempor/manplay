import { X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";
import { keyLabel, TRASH } from "#/lib/platform.ts";

type Group = { title: string; keys: [keys: string[], what: string][] };

/** Grouped by what you are trying to do; the vim letters sit beside the usual keys. */
const GROUPS: Group[] = [
	{
		title: "Move around",
		keys: [
			[["↑", "↓"], "Previous / next item"],
			[["←", "→"], "Close / open folder"],
			[["Enter"], "Go into folder, or play song"],
			[["⌫"], "Up one folder"],
			[["/"], "Filter this folder"],
			[["n", "N"], "Next / previous match"],
		],
	},
	{
		title: "Play",
		keys: [
			[["Space"], "Play or pause the selected song"],
			[["Double-click"], "Play a song, open a folder"],
		],
	},
	{
		title: "Organize",
		keys: [
			[["⌘N"], "New folder"],
			[["F2"], "Rename"],
			[["⌘X", "⌘C", "⌘V"], "Cut, copy, paste"],
			[["⌘⌫"], `Move to ${TRASH}`],
			[["⌘Z"], "Undo"],
			[["⌘A"], "Select all"],
		],
	},
	{
		title: "Fix and tag",
		keys: [
			[["[", "]"], "Previous / next issue"],
			[["i"], "Show the issue"],
			[["f"], "Fix the issue"],
			[["L"], "Jump to the metadata panel"],
		],
	},
	{
		title: "Vim keys",
		keys: [
			[["j", "k"], "Next / previous"],
			[["h", "l"], "Close / open folder"],
			[["gg", "G"], "First / last item"],
			[["-"], "Up one folder"],
			[["y", "x", "p"], "Copy, cut, paste"],
			[["r", "d", "a"], "Rename, delete, new folder"],
		],
	},
];

function Key({ children }: { children: string }) {
	return (
		<kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-muted/60 px-1.5 font-sans text-[11px] text-foreground">
			{keyLabel(children)}
		</kbd>
	);
}

/** Every file browser shortcut on one sheet; `?` opens it, Escape closes it. */
export function FileShortcuts({ onClose }: { onClose: () => void }) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" || e.key === "?") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div
				aria-hidden="true"
				onMouseDown={onClose}
				className="absolute inset-0 bg-background/60 backdrop-blur-sm"
			/>
			<div
				role="dialog"
				aria-label="Keyboard shortcuts"
				className="relative max-h-[calc(100%-4rem)] w-[44rem] max-w-[calc(100%-2rem)] overflow-y-auto rounded-xl border bg-background p-5 shadow-2xl"
			>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="font-medium text-sm">Keyboard shortcuts</h2>
					<Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
						<X />
					</Button>
				</div>
				<div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
					{GROUPS.map((g) => (
						<section key={g.title}>
							<h3 className="mb-1.5 text-muted-foreground text-xs">{g.title}</h3>
							<dl className="space-y-1">
								{g.keys.map(([keys, what]) => (
									<div key={what} className="flex items-center justify-between gap-3 text-sm">
										<dt className="text-foreground/90">{what}</dt>
										<dd className="flex shrink-0 gap-1">
											{keys.map((k) => (
												<Key key={k}>{k}</Key>
											))}
										</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
			</div>
		</div>
	);
}
