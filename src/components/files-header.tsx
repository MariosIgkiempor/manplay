import { useIsMutating } from "@tanstack/react-query";
import { Columns2, FolderOpen, RefreshCw, Tags, Undo2 } from "lucide-react";
import { BrandIcon } from "#/components/brand-icon.tsx";
import { brandOf } from "#/components/files-source-picker.tsx";
import { HeaderMenu, type HeaderMenuEntry } from "#/components/header-menu.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import { type SyncTarget, targetShortName } from "#/lib/api.ts";
import { PAGE_ART } from "#/lib/page-layout.ts";
import { keyLabel } from "#/lib/platform.ts";
import { SCAN_KEY, useLibraryRoot, useScan } from "#/lib/queries.ts";

export interface FilesHeaderProps {
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

/** One line under the title: how to use a destination, or that the library has no folder yet. */
function HeaderMeta({ target }: { target: SyncTarget | undefined }) {
	return target ? (
		<span>Drag files onto the library to copy them</span>
	) : (
		<span>No library folder yet</span>
	);
}

/** The Files header's `⋯` menu: undo, metadata's option, and rescan. */
function filesMenu(
	p: FilesHeaderProps,
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
 * The Files page's header. The controls that used to sit in rows above the panes live here: what
 * split view, undo, metadata and rescan. What each pane shows is the first crumb of its path.
 */
export function FilesHeader(p: FilesHeaderProps) {
	const root = useLibraryRoot();
	const scan = useScan();
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	const { target } = p;
	return (
		<PageHeader
			// A destination shows its brand; the library is the app's own page and needs none.
			art={target ? <BrandIcon brand={brandOf(target)} className={PAGE_ART} /> : null}
			title={target ? targetShortName(target) : "Files"}
			titleHint={target ? [target.machine, ...target.path].join(" / ") : (root.data ?? undefined)}
			meta={(target ?? !root.data) && <HeaderMeta target={target} />}
			actions={
				<>
					{p.hasLocal && (
						<Button
							variant={p.tagsOpen ? "secondary" : "outline"}
							onClick={p.onToggleTags}
							disabled={!p.canOpenTags}
						>
							<Tags />
							Metadata
						</Button>
					)}
					<Button
						variant={p.split ? "secondary" : "outline"}
						size="icon"
						aria-pressed={p.split}
						aria-label={p.split ? "Close the second pane" : "Open a second pane"}
						title={p.split ? "Close the second pane" : "Open a second pane"}
						onClick={p.onToggleSplit}
					>
						<Columns2 />
					</Button>
					<HeaderMenu entries={filesMenu(p, root.data, scanning, scan.mutate)} />
				</>
			}
		/>
	);
}
