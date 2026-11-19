import { ChevronRight, Folder } from "lucide-react";
import { type CSSProperties, useState } from "react";
import { TONE } from "#/components/diff-view.tsx";
import { ItemRow, type ReviewControls, TickAll } from "#/components/sync-review-item.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { TargetPlan } from "#/lib/api.ts";
import {
	buildTree,
	type FolderTally,
	itemKey,
	itemsUnder,
	type ReviewItem,
	TALLY_TONES,
	type TreeEntry,
	type TreeFolder,
	type TreeRow,
	treeRows,
} from "#/lib/sync-review-model.ts";
import { cn } from "#/lib/utils.ts";

const ROWS_PER_PAGE = 300;

const indent = (depth: number): CSSProperties => ({
	paddingLeft: `calc(var(--diff-inset) + ${depth * 1.125}rem)`,
});

function Roll({ tally }: { tally: FolderTally }) {
	return (
		<span className="ml-auto flex shrink-0 gap-2 font-mono text-[11px] tabular-nums">
			{TALLY_TONES.filter((t) => tally[t] > 0).map((t) => (
				<span key={t} className={TONE[t].text}>
					{TONE[t].sign}
					{tally[t].toLocaleString()}
				</span>
			))}
		</span>
	);
}

function Ghost({ entry }: { entry: TreeEntry & { ghost: true } }) {
	const a = entry.item.action;
	return (
		<div className="flex items-center gap-2 text-sm">
			<span className="w-3.5 shrink-0" />
			<span
				aria-hidden="true"
				className={cn("w-3 text-center font-mono font-semibold", TONE.move.text)}
			>
				→
			</span>
			<span className="min-w-0 flex-1 break-words text-muted-foreground line-through">
				{a.from?.at(-1)}
			</span>
			<span className="shrink-0 text-muted-foreground text-xs">
				moved to {a.rel.slice(0, -1).join("/") || "(top level)"}
			</span>
		</div>
	);
}

function FolderRow({
	folder,
	depth,
	open,
	onFold,
	controls,
}: {
	folder: TreeFolder;
	depth: number;
	open: boolean;
	onFold: () => void;
	controls: ReviewControls;
}) {
	return (
		<div
			className="flex min-h-8 items-center gap-2 pr-[var(--diff-inset)] text-sm hover:bg-muted/40"
			style={indent(depth)}
		>
			<button
				type="button"
				aria-expanded={open}
				aria-label={`${open ? "Fold" : "Unfold"} ${folder.path}`}
				onClick={onFold}
				className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
						open && "rotate-90",
					)}
				/>
				<Folder className="size-4 shrink-0 text-muted-foreground" />
				<span className="min-w-0 break-words font-medium">{folder.name}</span>
			</button>
			<Roll tally={folder.tally} />
			<TickAll
				items={itemsUnder(folder)}
				controls={controls}
				label={`Tick all in ${folder.path}`}
			/>
		</div>
	);
}

function Line({
	row,
	controls,
	onFold,
}: {
	row: TreeRow;
	controls: ReviewControls;
	onFold: (path: string) => void;
}) {
	if (row.type === "folder") {
		return (
			<FolderRow
				folder={row.folder}
				depth={row.depth}
				open={row.open}
				onFold={() => onFold(row.folder.path)}
				controls={controls}
			/>
		);
	}
	if (row.type === "unchanged") {
		return (
			<p
				className="py-1 pr-[var(--diff-inset)] text-muted-foreground text-xs italic"
				style={indent(row.depth)}
			>
				<span className="ml-[2.75rem]">
					{row.count.toLocaleString()} unchanged {row.count === 1 ? "file" : "files"}
				</span>
			</p>
		);
	}
	const e = row.entry;
	return (
		<div className="py-1 pr-[var(--diff-inset)] hover:bg-muted/40" style={indent(row.depth)}>
			{e.ghost ? (
				<Ghost entry={e} />
			) : (
				<ItemRow item={e.item} controls={controls} moveAs="folder" />
			)}
		</div>
	);
}

const rowKey = (row: TreeRow): string => {
	if (row.type === "entry") {
		return `${row.entry.ghost ? "ghost" : "file"}:${itemKey(row.entry.item)}`;
	}
	return `${row.type}:${row.type === "folder" ? row.folder.path : row.path}`;
};

/**
 * The destination's folders as they will look after the sync. Each folder shows what happens
 * under it and folds; a moved file shows at its new path and, struck through, at its old one.
 * Files only on the destination are outlined, with their choice inline.
 */
export function FolderTree({
	items,
	folders,
	controls,
	showUnchanged,
}: {
	items: readonly ReviewItem[];
	folders: TargetPlan["folders"];
	controls: ReviewControls;
	showUnchanged: boolean;
}) {
	const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
	const [shown, setShown] = useState(ROWS_PER_PAGE);
	const rows = treeRows(
		buildTree(items, folders, controls.there, showUnchanged),
		closed,
		showUnchanged,
	);
	const fold = (path: string) =>
		setClosed((s) => {
			const next = new Set(s);
			if (!next.delete(path)) {
				next.add(path);
			}
			return next;
		});
	return (
		<div className="py-2">
			{rows.slice(0, shown).map((row) => (
				<Line key={rowKey(row)} row={row} controls={controls} onFold={fold} />
			))}
			{rows.length === 0 && (
				<p className="px-[var(--diff-inset)] py-3 text-muted-foreground text-sm">
					Nothing changes on the destination.
				</p>
			)}
			{rows.length > shown && (
				<Button
					variant="ghost"
					size="sm"
					className="mx-[var(--diff-inset)] my-2"
					onClick={() => setShown(shown + ROWS_PER_PAGE)}
				>
					Show more ({(rows.length - shown).toLocaleString()} lines hidden)
				</Button>
			)}
		</div>
	);
}
