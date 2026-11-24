import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "#/components/ui/button.tsx";
import { FLOATING_FRAME, WELL } from "#/lib/page-layout.ts";
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

/**
 * Every file browser shortcut on one sheet, with the keys chosen in Settings; its key opens it.
 * It grows out of the Shortcuts button at the foot of the browser and leaves the page usable: no
 * backdrop, and a click anywhere else puts it away.
 */
export function FileShortcuts({ onClose }: { onClose: () => void }) {
	const sheet = useRef<HTMLElement>(null);
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
		const onPress = (e: MouseEvent) => {
			if (
				e.timeStamp >= openedAt &&
				e.target instanceof Node &&
				!sheet.current?.contains(e.target)
			) {
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("mousedown", onPress);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onPress);
		};
	}, [onClose]);
	return (
		<div className="pointer-events-none absolute inset-x-2 top-2 bottom-8 z-30 flex items-end justify-end">
			{/* A frame round a well, as a section of a page is; its name and ✕ on the frame's lip. */}
			<section
				ref={sheet}
				aria-label="Keyboard shortcuts"
				className={cn(
					FLOATING_FRAME,
					"pointer-events-auto flex max-h-full w-[44rem] max-w-full origin-bottom-right animate-in flex-col duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] fade-in-0 zoom-in-[0.9] slide-in-from-bottom-2 motion-reduce:animate-none",
				)}
			>
				<div className="flex items-center justify-between py-0.5 pr-1 pl-3">
					<h2 className="font-medium text-[0.9375rem]">Keyboard shortcuts</h2>
					<Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
						<X />
					</Button>
				</div>
				<div className={cn(WELL, "min-h-0 overflow-y-auto p-4")}>
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
			</section>
		</div>
	);
}
