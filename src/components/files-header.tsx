import { Menu } from "@base-ui/react/menu";
import { useIsMutating } from "@tanstack/react-query";
import { Check, ChevronDown, Columns2, Square, Tags, Undo2 } from "lucide-react";
import { BrandIcon } from "#/components/brand-icon.tsx";
import { FolderFigure } from "#/components/destination-header.tsx";
import { brandOf, FilesSourcePicker } from "#/components/files-source-picker.tsx";
import { ScanButtons } from "#/components/library-parts.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { SyncTarget } from "#/lib/api.ts";
import { menuItem, popup } from "#/lib/menu-styles.ts";
import { SCAN_KEY, useLibraryRoot, useScan } from "#/lib/queries.ts";

export interface FilesHeaderProps {
	/** The destination shown in the first pane, if any. */
	target: SyncTarget | undefined;
	onSourceChange: (id: number | undefined) => void;
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

/** Metadata's options: a small menu beside the Metadata button. */
function MetadataOptions({
	autoOpen,
	onAutoOpen,
}: Pick<FilesHeaderProps, "autoOpen" | "onAutoOpen">) {
	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button
						variant="outline"
						size="icon"
						aria-label="Metadata options"
						title="Metadata options"
					/>
				}
			>
				<ChevronDown />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={6} align="end" className="z-50">
					<Menu.Popup className={popup}>
						<Menu.CheckboxItem checked={autoOpen} onCheckedChange={onAutoOpen} className={menuItem}>
							<Menu.CheckboxItemIndicator keepMounted className="data-[unchecked]:invisible">
								<Check />
							</Menu.CheckboxItemIndicator>
							Open when selecting a song or folder
						</Menu.CheckboxItem>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function HeaderMeta({
	target,
	root,
}: {
	target: SyncTarget | undefined;
	root: string | null | undefined;
}) {
	if (target) {
		return <span>Destination · drag files onto the library to copy them</span>;
	}
	return root ? <FolderFigure path={root} /> : <span>No library folder yet</span>;
}

/**
 * The Files page's header. The controls that used to sit in rows above the panes live here: what
 * the first pane shows, split view, undo, metadata and rescan.
 */
export function FilesHeader(p: FilesHeaderProps) {
	const root = useLibraryRoot();
	const scan = useScan();
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	const { target } = p;
	return (
		<PageHeader
			art={
				<BrandIcon
					brand={target ? brandOf(target) : "library"}
					className="size-28 rounded-lg shadow-lg"
				/>
			}
			title={target ? [target.machine, ...target.path].join(" / ") : "Files"}
			meta={<HeaderMeta target={target} root={root.data} />}
			actions={
				<>
					{/* Split panes each choose their own source, in their toolbar. */}
					{!p.split && <FilesSourcePicker value={target?.id} onChange={p.onSourceChange} />}
					<Button
						variant="outline"
						title={p.split ? "Back to one pane" : "Show two panes side by side"}
						onClick={p.onToggleSplit}
					>
						{p.split ? <Square /> : <Columns2 />}
						{p.split ? "One pane" : "Split"}
					</Button>
					{p.hasLocal && (
						<>
							<Button
								variant="outline"
								onClick={p.onUndo}
								disabled={!p.canUndo}
								title={p.undoLabel ? `Undo ${p.undoLabel} (⌘Z)` : "Nothing to undo"}
							>
								<Undo2 />
								Undo
							</Button>
							<Button
								variant={p.tagsOpen ? "secondary" : "outline"}
								onClick={p.onToggleTags}
								disabled={!p.canOpenTags}
							>
								<Tags />
								Metadata
							</Button>
							<MetadataOptions autoOpen={p.autoOpen} onAutoOpen={p.onAutoOpen} />
						</>
					)}
					{!target && (
						<ScanButtons
							hasRoot={!!root.data}
							scanning={scanning}
							onScan={(mode) => scan.mutate(mode)}
						/>
					)}
				</>
			}
		/>
	);
}
