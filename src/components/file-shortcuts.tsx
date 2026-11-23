import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";
import { useExitGhost } from "#/lib/exit-ghost.ts";
import { DIALOG_BACKDROP, DIALOG_FRAME } from "#/lib/page-layout.ts";
import { keyLabel } from "#/lib/platform.ts";
import { chordLabel, SHORTCUTS } from "#/lib/shortcuts.ts";
import { shortcutFor, useBindings, useMacLabels } from "#/lib/use-shortcuts.ts";
import { cn } from "#/lib/utils.ts";

/** One key, as on the keyboard; ⌘ reads Ctrl on Windows. */
export function Key({ children }: { children: string }) {
	return (
		<kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 bg-muted/60 px-1.5 font-sans text-[11px] text-foreground">
			{keyLabel(children)}
		</kbd>
	);
}

/** Every file browser shortcut on one sheet, with the keys chosen in Settings; its key opens it. */
export function FileShortcuts({ onClose }: { onClose: () => void }) {
	const overlay = useExitGhost();
	const bindings = useBindings();
	const mac = useMacLabels();
	const files = SHORTCUTS.filter((d) => d.scope === "files");
	const groups = [...new Set(files.map((d) => d.group))];
	useEffect(() => {
		// The key press that opened the sheet reaches this listener too; only later ones close it.
		const openedAt = performance.now();
		const onKey = (e: KeyboardEvent) => {
			if (e.timeStamp < openedAt) {
				return;
			}
			if (e.key === "Escape" || shortcutFor(e, "files")?.id === "fileHelp") {
				e.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div ref={overlay} className="fixed inset-0 z-50 flex items-center justify-center">
			<div aria-hidden="true" onMouseDown={onClose} className={DIALOG_BACKDROP} />
			<div
				role="dialog"
				data-exit
				aria-label="Keyboard shortcuts"
				className={cn(
					DIALOG_FRAME,
					"max-h-[calc(100%-4rem)] w-[44rem] max-w-[calc(100%-2rem)] overflow-y-auto p-5",
				)}
			>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="font-medium text-sm">Keyboard shortcuts</h2>
					<Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
						<X />
					</Button>
				</div>
				<div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
					{groups.map((group) => (
						<section key={group}>
							<h3 className="mb-1.5 text-muted-foreground text-xs">{group}</h3>
							<dl className="space-y-1">
								{files
									.filter((d) => d.group === group)
									.map((d) => (
										<div key={d.id} className="flex items-center justify-between gap-3 text-sm">
											<dt className="text-foreground/90">{d.label}</dt>
											<dd className="flex shrink-0 gap-1">
												{(bindings.get(d.id) ?? []).map((k) => (
													<Key key={k}>{chordLabel(k, mac)}</Key>
												))}
											</dd>
										</div>
									))}
							</dl>
						</section>
					))}
				</div>
				<p className="mt-5 flex items-center justify-between gap-3 text-muted-foreground text-xs">
					Double-click plays a song or opens a folder.
					<Link
						to="/settings"
						search={{ section: "shortcuts" }}
						onClick={onClose}
						className="text-foreground underline-offset-2 hover:underline"
					>
						Change keys in Settings
					</Link>
				</p>
			</div>
		</div>
	);
}
