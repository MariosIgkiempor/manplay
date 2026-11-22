import { useIsMutating } from "@tanstack/react-query";
import { Columns2, FolderOpen, RefreshCw, Tags, Undo2 } from "lucide-react";
import { HeaderMenu, type HeaderMenuEntry } from "#/components/header-menu.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { SyncTarget } from "#/lib/api.ts";
import { keyLabel } from "#/lib/platform.ts";
import { SCAN_KEY, useLibraryRoot, useScan } from "#/lib/queries.ts";

export interface FilesToolsProps {
	/** The destination shown in the first pane, if any. */
	target: SyncTarget | undefined;
	split: boolean;
	onToggleSplit: () => void;
	/** Some pane shows the library, so undo and metadata apply. */
	hasLocal: boolean;
	canUndo: boolean;
	undoLabel: string | null;
	onUndo: () => void;
	tagsOpen: boolean;
	canOpenTags: boolean;
	onToggleTags: () => void;
	autoOpen: boolean;
	onAutoOpen: (on: boolean) => void;
}

/** The Files `⋯` menu: undo, metadata's option, and rescan. */
function filesMenu(
	p: FilesToolsProps,
	root: string | null | undefined,
	scanning: boolean,
	onScan: (mode: "saved" | "pick") => void,
): HeaderMenuEntry[] {
	const local: HeaderMenuEntry[] = p.hasLocal
		? [
				{
					label: p.undoLabel ? `Undo ${p.undoLabel}` : "Undo",
					icon: <Undo2 />,
					hint: keyLabel("⌘Z"),
					onSelect: p.onUndo,
					disabled: !p.canUndo,
				},
				"separator",
				{
					label: "Open metadata when selecting a song or folder",
					checked: p.autoOpen,
					onSelect: () => p.onAutoOpen(!p.autoOpen),
				},
			]
		: [];
	const library: HeaderMenuEntry = root
		? {
				label: scanning ? "Scanning…" : "Rescan",
				icon: <RefreshCw />,
				hint: "Look for added, changed and removed files",
				onSelect: () => onScan("saved"),
				disabled: scanning,
			}
		: {
				label: "Choose library folder…",
				icon: <FolderOpen />,
				onSelect: () => onScan("pick"),
				disabled: scanning,
			};
	return [...local, "separator", p.target ? null : library];
}

/**
 * The Files page's own controls, at the end of the first pane's toolbar: metadata, split view, and
 * a menu with undo and rescan. The page has no header; what each pane shows is its first crumb.
 */
export function FilesTools(p: FilesToolsProps) {
	const root = useLibraryRoot();
	const scan = useScan();
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	const splitLabel = p.split ? "Close the second pane" : "Open a second pane";
	return (
		<div className="flex shrink-0 items-center gap-0.5">
			{p.hasLocal && (
				<Button
					variant={p.tagsOpen ? "secondary" : "ghost"}
					size="icon-sm"
					aria-pressed={p.tagsOpen}
					aria-label="Metadata"
					data-hint="Metadata"
					onClick={p.onToggleTags}
					disabled={!p.canOpenTags}
				>
					<Tags />
				</Button>
			)}
			<Button
				variant={p.split ? "secondary" : "ghost"}
				size="icon-sm"
				aria-pressed={p.split}
				aria-label={splitLabel}
				data-hint={splitLabel}
				onClick={p.onToggleSplit}
			>
				<Columns2 />
			</Button>
			<HeaderMenu size="sm" entries={filesMenu(p, root.data, scanning, scan.mutate)} />
		</div>
	);
}
