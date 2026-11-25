import { useIsMutating } from "@tanstack/react-query";
import { Columns2, FolderOpen, RefreshCw, Tags } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import type { SyncTarget } from "#/lib/api.ts";
import { SCAN_KEY, useLibraryRoot, useScan } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

export interface FilesToolsProps {
	/** The destination shown in the first pane, if any. */
	target: SyncTarget | undefined;
	split: boolean;
	onToggleSplit: () => void;
	/** Some pane shows the library, so metadata applies. */
	hasLocal: boolean;
	tagsOpen: boolean;
	canOpenTags: boolean;
	onToggleTags: () => void;
}

/**
 * The Files page's own controls, at the end of the first pane's toolbar: metadata, rescan (or
 * choosing the library folder when there is none yet) and split view. The page has no header;
 * what each pane shows is its first crumb.
 */
export function FilesTools(p: FilesToolsProps) {
	const root = useLibraryRoot();
	const scan = useScan();
	const scanning = useIsMutating({ mutationKey: SCAN_KEY }) > 0;
	const splitLabel = p.split ? "Close the second pane" : "Open a second pane";
	const hasRoot = typeof root.data === "string";
	const scanLabel = scanning
		? "Scanning…"
		: hasRoot
			? "Rescan: look for added, changed and removed files"
			: "Choose library folder…";
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
			{p.target === undefined && (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={scanLabel}
					data-hint={scanLabel}
					disabled={scanning}
					onClick={() => scan.mutate(hasRoot ? "saved" : "pick")}
				>
					{hasRoot ? (
						<RefreshCw className={cn(scanning && "animate-spin motion-reduce:animate-none")} />
					) : (
						<FolderOpen />
					)}
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
		</div>
	);
}
