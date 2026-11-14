import { ContextMenu } from "@base-ui/react/context-menu";
import {
	ArrowRight,
	ArrowUp,
	ChevronRight,
	ClipboardPaste,
	Columns2,
	Copy,
	File as FileIcon,
	Folder,
	FolderOpen,
	FolderPlus,
	Pencil,
	Scissors,
	Square,
	Tags,
	Trash2,
	Wrench,
} from "lucide-react";
import {
	type DragEvent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { ErrorText } from "#/components/error-text.tsx";
import { IssuePopover } from "#/components/issue-popover.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { type FsEntry, pathArtUrl } from "#/lib/api.ts";
import type { IssueIndex } from "#/lib/audit.ts";
import { isAudioName, joinPath, parentPath, relSegments } from "#/lib/fs-path.ts";
import { applyClick, EMPTY_SELECTION, type Selection } from "#/lib/selection.ts";
import { forTarget, type TagClipboard } from "#/lib/tag-clipboard.ts";
import { labelOf } from "#/lib/tag-preview.ts";
import type { TreeRow } from "#/lib/tree.ts";
import { useFileDrag } from "#/lib/use-file-drag.ts";
import type { FsClipboard } from "#/lib/use-fs-ops.ts";
import { useFsOps } from "#/lib/use-fs-ops.ts";
import { undoMakeDir, undoRename } from "#/lib/use-fs-undo.ts";
import { useIssueNav } from "#/lib/use-issue-nav.ts";
import { useTree } from "#/lib/use-tree.ts";
import { cn } from "#/lib/utils.ts";

/** Pixels of indent per tree level. */
const INDENT = 16;

function size(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	const units = ["KB", "MB", "GB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Keeps pane shortcuts working after a click, unless the click was in a text box or a popover. */
function focusUnlessTyping(ev: MouseEvent<HTMLElement>) {
	const inside = ev.currentTarget.contains(ev.target as Node);
	if (inside && !(ev.target instanceof HTMLInputElement)) {
		ev.currentTarget.focus();
	}
}

/** ArrowLeft on a row: close it if it is an open folder, else select its parent folder. */
function collapseRow(
	row: TreeRow | undefined,
	expanded: ReadonlySet<string>,
	base: string,
	setOpen: (dir: string, open: boolean) => void,
	select: (path: string) => void,
) {
	if (row === undefined) {
		return;
	}
	if (row.entry.isDir && expanded.has(row.path)) {
		setOpen(row.path, false);
	} else if (row.parent !== base) {
		select(row.parent);
	}
}

import type { UndoEntry } from "#/context/undo-context.ts";

interface PaneProps {
	/** Remembers an operation on the shared undo stack. */
	onRecord: (entry: UndoEntry) => void;
	clipboard: FsClipboard | null;
	setClipboard: (c: FsClipboard | null) => void;
	root: string;
	path: string;
	onNavigate: (path: string) => void;
	active: boolean;
	onActivate: () => void;
	/** The other pane's folder, when the view is split. */
	otherPath: string | null;
	onToggleSplit: () => void;
	/** Library health findings, for the warning icons. */
	health: IssueIndex;
	fixing: boolean;
	/** Fixes the fixable files at or under these paths (after asking the user). */
	onFix: (scopes: string[]) => unknown;
	/** Reports the single song or folder the user selected, for the tag pane. */
	onSelectTarget: (target: { path: string; name: string; isDir: boolean }) => unknown;
	/** Opens the tag editor for a song or folder. */
	onEditTags: (target: { path: string; name: string; isDir: boolean }) => unknown;
	/** Tags currently on the tag clipboard (`null` when empty), for the Paste entry. */
	tagClipboard: TagClipboard | null;
	onCopyTags: (target: { path: string; name: string; isDir: boolean }) => unknown;
	onPasteTags: (targets: { path: string; name: string; isDir: boolean }[]) => unknown;
}

export function FilePane({
	onRecord,
	clipboard,
	setClipboard,
	root,
	path,
	onNavigate,
	active,
	onActivate,
	otherPath,
	onToggleSplit,
	health,
	fixing,
	onFix,
	onEditTags,
	onSelectTarget,
	tagClipboard,
	onCopyTags,
	onPasteTags,
}: PaneProps) {
	const {
		listing,
		entries: listed,
		rows,
		rowByPath,
		expanded,
		isLoading,
		setOpen,
		forget,
	} = useTree(path);
	const visible = rows.map((r) => r.path);

	const [sel, setSel] = useState<Selection<string>>(EMPTY_SELECTION);
	const [renaming, setRenaming] = useState<string | null>(null);
	/** Folder a new folder is being named in. */
	const [creatingIn, setCreatingIn] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sectionRef = useRef<HTMLElement>(null);

	// A refresh or a collapsed folder must not leave selections on rows that are gone.
	const selected = new Set([...sel.selected].filter((p) => rowByPath.has(p)));
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the folder changes
	useEffect(() => {
		setSel(EMPTY_SELECTION);
		setRenaming(null);
		setCreatingIn(null);
		setError(null);
	}, [path]);

	const { makeDir, rename, busy, fail, runMove, paste, remove, record } = useFsOps({
		record: onRecord,
		clipboard,
		setClipboard,
		setError,
		setOpen,
		forget,
		clearSelection: () => setSel(EMPTY_SELECTION),
	});
	const atRoot = path === root;
	/** The other pane is a different folder, so "move to other pane" does something. */
	const movable = otherPath !== null && otherPath !== path;
	const crumbs = relSegments(root, path);

	const drag = useFileDrag({
		selected,
		selectOnly: (p) => setSel({ selected: new Set([p]), anchor: p }),
		onDrop: runMove,
	});

	/** Folders open in place (chevron); double-click and Enter go into them. */
	const enter = (r: TreeRow) => r.entry.isDir && onNavigate(r.path);

	const onRowClick = (
		r: TreeRow,
		ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
	) => {
		onActivate();
		setSel((prev) =>
			applyClick(prev, visible, r.path, { shift: ev.shiftKey, toggle: ev.metaKey || ev.ctrlKey }),
		);
	};

	const pathsOf = (r?: TreeRow) => (r && !selected.has(r.path) ? [r.path] : [...selected]);
	const onlySelected = selected.size === 1 ? rowByPath.get([...selected][0] ?? "") : undefined;
	/** Where "new folder" and "paste" land from the keyboard: the selected folder, else this one. */
	// Tell the tag pane about a newly selected song or folder (other files are ignored).
	const selectRef = useRef(onSelectTarget);
	selectRef.current = onSelectTarget;
	const pickedPath = onlySelected?.path;
	const pickedName = onlySelected?.entry.name;
	const pickedDir = onlySelected?.entry.isDir;
	useEffect(() => {
		if (
			pickedPath !== undefined &&
			pickedName !== undefined &&
			(pickedDir || isAudioName(pickedName))
		) {
			selectRef.current({ path: pickedPath, name: pickedName, isDir: pickedDir ?? false });
		}
	}, [pickedPath, pickedName, pickedDir]);
	const keyboardDest = onlySelected?.entry.isDir ? onlySelected.path : path;

	const actions: PaneActionSet = {
		open: (r) => enter(r),
		rename: (p) => setRenaming(p),
		newFolder: (parent) => {
			setOpen(parent, true);
			setCreatingIn(parent);
		},
		cut: (paths) => paths.length > 0 && setClipboard({ mode: "cut", paths }),
		copy: (paths) => paths.length > 0 && setClipboard({ mode: "copy", paths }),
		paste,
		remove,
		moveToOther: (paths) => otherPath !== null && runMove(paths, otherPath),
		fix: (paths) => onFix(paths),
		editTags: (r) => onEditTags({ path: r.path, name: r.entry.name, isDir: r.entry.isDir }),
		copyTags: (r) => onCopyTags({ path: r.path, name: r.entry.name, isDir: r.entry.isDir }),
		pasteTags: (paths) =>
			onPasteTags(
				paths.flatMap((p) => {
					const r = rowByPath.get(p);
					return r && (r.entry.isDir || isAudioName(r.entry.name))
						? [{ path: r.path, name: r.entry.name, isDir: r.entry.isDir }]
						: [];
				}),
			),
	};

	const issueNav = useIssueNav({
		visible,
		health,
		anchor: sel.anchor,
		selected,
		setSel,
		onFix,
		paneRef: sectionRef,
	});

	const onKeyDown = (ev: KeyboardEvent) => {
		const action = keyAction(ev, renaming !== null || creatingIn !== null);
		if (action === null) {
			return;
		}
		const run: Record<Exclude<KeyAction, null>, () => unknown> = {
			rename: () => onlySelected && setRenaming(onlySelected.path),
			open: () => onlySelected && enter(onlySelected),
			up: () => !atRoot && onNavigate(parentPath(path)),
			all: () => setSel({ selected: new Set(visible), anchor: null }),
			clear: () => setSel(EMPTY_SELECTION),
			newFolder: () => actions.newFolder(keyboardDest),
			cut: () => actions.cut(pathsOf()),
			copy: () => actions.copy(pathsOf()),
			paste: () => actions.paste(keyboardDest),
			delete: () => actions.remove(pathsOf()),
			...issueNav.keys,
			expand: () => onlySelected?.entry.isDir && setOpen(onlySelected.path, true),
			collapse: () =>
				collapseRow(onlySelected, expanded, path, setOpen, (p) =>
					setSel({ selected: new Set([p]), anchor: p }),
				),
		};
		ev.preventDefault();
		run[action]();
	};

	const submitRename = (r: TreeRow, newName: string) => {
		if (newName === r.entry.name) {
			setRenaming(null);
			return;
		}
		rename.mutate(
			{ path: r.path, newName },
			{
				onError: fail,
				onSuccess: () => {
					forget([r.path]);
					setRenaming(null);
					const to = joinPath(r.parent, newName);
					record(undoRename(r.path, to));
					setSel({ selected: new Set([to]), anchor: to });
				},
			},
		);
	};

	const submitNewFolder = (parent: string, name: string) =>
		makeDir.mutate(
			{ parent, name },
			{
				onError: fail,
				onSuccess: () => {
					setCreatingIn(null);
					const to = joinPath(parent, name);
					record(undoMakeDir(to));
					setSel({ selected: new Set([to]), anchor: to });
				},
			},
		);

	const menuCtx = {
		actions,
		hasClipboard: clipboard !== null,
		tagClipboard,
		canMoveToOther: movable,
		fixing,
	};
	const fixableIn = (r: TreeRow): number =>
		r.entry.isDir
			? (health.folders.get(r.path)?.fixable ?? 0)
			: Number(health.byPath.get(r.path)?.some((i) => i.fixable) ?? false);
	const menuFor = (r: TreeRow) =>
		buildMenu(menuCtx, {
			entry: r,
			paths: pathsOf(r),
			dest: r.entry.isDir ? r.path : r.parent,
			fixable: fixableIn(r),
		});
	const paneMenu = buildMenu(menuCtx, { paths: [], dest: path, fixable: 0 });
	const selectForMenu = (r: TreeRow) => {
		onActivate();
		if (!selected.has(r.path)) {
			setSel({ selected: new Set([r.path]), anchor: r.path });
		}
	};

	const newFolderRow = (parent: string, depth: number) => (
		<NameRow
			key={`new-${parent}`}
			depth={depth}
			icon={<Folder className="size-4 text-primary" />}
			initial=""
			placeholder="New folder"
			onCancel={() => setCreatingIn(null)}
			onSubmit={(name) => submitNewFolder(parent, name)}
		/>
	);

	const selectedPaths = [...selected];

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pane-level keyboard shortcuts
		<section
			ref={sectionRef}
			tabIndex={-1}
			className={cn(
				"flex min-h-0 min-w-0 flex-1 flex-col border-r bg-card/40 outline-none last:border-r-0",
				active && "bg-card/70",
			)}
			onKeyDown={onKeyDown}
			onMouseDown={(ev) => {
				onActivate();
				focusUnlessTyping(ev);
			}}
		>
			<div className="flex items-center gap-1 border-b p-2">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Up one folder"
					disabled={atRoot}
					onClick={() => onNavigate(parentPath(path))}
				>
					<ArrowUp />
				</Button>
				<Breadcrumbs root={root} crumbs={crumbs} drag={drag} onNavigate={onNavigate} />
				<PaneActions
					busy={busy}
					count={selected.size}
					split={otherPath !== null}
					canMove={movable}
					onNewFolder={() => actions.newFolder(keyboardDest)}
					onRename={() => setRenaming(selectedPaths[0] ?? null)}
					onToggleSplit={onToggleSplit}
					onMove={() => otherPath !== null && runMove(selectedPaths, otherPath)}
				/>
			</div>

			{error && (
				<p className="border-b bg-destructive/10 px-3 py-1.5 text-destructive text-xs">{error}</p>
			)}
			{listing?.isError && (
				<ErrorText className="px-3 py-2 text-destructive text-sm" message={String(listing.error)} />
			)}

			<MenuShell items={paneMenu}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for the current folder */}
				<div
					className={cn(
						"min-h-0 flex-1 overflow-y-auto",
						drag.dropTarget === path && "bg-primary/10",
					)}
					onDragOver={(ev) => drag.allowDrop(ev, path)}
					onDragLeave={drag.clearDrop}
					onDrop={(ev) => drag.dropInto(ev, path)}
				>
					{creatingIn === path && newFolderRow(path, 0)}
					{rows.flatMap((r) => {
						const row =
							renaming === r.path ? (
								<NameRow
									key={r.path}
									depth={r.depth}
									icon={<EntryIcon entry={r.entry} />}
									initial={r.entry.name}
									onCancel={() => setRenaming(null)}
									onSubmit={(newName) => submitRename(r, newName)}
								/>
							) : (
								<EntryRow
									key={r.path}
									row={r}
									selected={selected.has(r.path)}
									active={active}
									expanded={expanded}
									isLoading={isLoading}
									health={health}
									fixing={fixing}
									onFix={onFix}
									issueOpen={issueNav.issueOpen === r.path}
									onIssueOpen={(open) => issueNav.toggleIssue(r.path, open)}
									clipboard={clipboard}
									dropTarget={drag.dropTarget}
									onToggle={() => setOpen(r.path, !expanded.has(r.path))}
									onDragStart={(ev) => drag.dragStart(ev, r.path)}
									onClick={(ev) => onRowClick(r, ev)}
									onOpen={() => enter(r)}
									onDragOver={(ev) => drag.allowDrop(ev, r.path)}
									onDragLeave={drag.clearDrop}
									onDrop={(ev) => drag.dropInto(ev, r.path)}
									menu={menuFor(r)}
									onContextMenu={() => selectForMenu(r)}
								/>
							);
						return r.entry.isDir && creatingIn === r.path
							? [row, newFolderRow(r.path, r.depth + 1)]
							: [row];
					})}
					{listing?.isSuccess && listed.length === 0 && creatingIn !== path && (
						<p className="p-3 text-muted-foreground text-sm">Empty folder.</p>
					)}
				</div>
			</MenuShell>
			<div className="border-t px-3 py-1 text-muted-foreground text-xs">
				{listed.length} item{listed.length === 1 ? "" : "s"}
				{selected.size > 0 && ` · ${selected.size} selected`}
			</div>
		</section>
	);
}

function Breadcrumbs({
	root,
	crumbs,
	drag,
	onNavigate,
}: {
	root: string;
	crumbs: string[];
	drag: ReturnType<typeof useFileDrag>;
	onNavigate: (path: string) => void;
}) {
	const { dropTarget, allowDrop, clearDrop, dropInto } = drag;
	return (
		<nav className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-sm">
			<button
				type="button"
				className="rounded px-1 font-medium hover:bg-muted"
				onClick={() => onNavigate(root)}
				onDragOver={(ev) => allowDrop(ev, root)}
				onDragLeave={clearDrop}
				onDrop={(ev) => dropInto(ev, root)}
			>
				Library
			</button>
			{crumbs.map((seg, i) => {
				const to = joinPath(root, ...crumbs.slice(0, i + 1));
				return (
					<span key={to} className="flex items-center gap-0.5">
						<ChevronRight className="size-3 text-muted-foreground" />
						<button
							type="button"
							className={cn("rounded px-1 hover:bg-muted", dropTarget === to && "bg-primary/20")}
							onClick={() => onNavigate(to)}
							onDragOver={(ev) => allowDrop(ev, to)}
							onDragLeave={clearDrop}
							onDrop={(ev) => dropInto(ev, to)}
						>
							{seg}
						</button>
					</span>
				);
			})}
		</nav>
	);
}

function PaneActions({
	busy,
	count,
	split,
	canMove,
	onNewFolder,
	onRename,
	onToggleSplit,
	onMove,
}: {
	busy: boolean;
	count: number;
	split: boolean;
	canMove: boolean;
	onNewFolder: () => void;
	onRename: () => void;
	onToggleSplit: () => void;
	onMove: () => void;
}) {
	const splitLabel = split ? "Single pane" : "Split panes";
	return (
		<>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="New folder"
				title="New folder"
				disabled={busy}
				onClick={onNewFolder}
			>
				<FolderPlus />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Rename (F2)"
				title="Rename (F2)"
				disabled={busy || count !== 1}
				onClick={onRename}
			>
				<Pencil />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={splitLabel}
				title={splitLabel}
				onClick={onToggleSplit}
			>
				{split ? <Square /> : <Columns2 />}
			</Button>
			{split && (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Move selection to the other pane"
					title="Move selection to the other pane"
					disabled={busy || count === 0 || !canMove}
					onClick={onMove}
				>
					<ArrowRight />
				</Button>
			)}
		</>
	);
}

type KeyAction =
	| "rename"
	| "open"
	| "up"
	| "all"
	| "clear"
	| "newFolder"
	| "cut"
	| "copy"
	| "paste"
	| "delete"
	| "expand"
	| "collapse"
	| "next"
	| "prev"
	| "nextIssue"
	| "prevIssue"
	| "issues"
	| "fix"
	| null;

const KEYS: Record<string, KeyAction> = {
	"mod+n": "newFolder",
	"mod+c": "copy",
	"mod+x": "cut",
	"mod+v": "paste",
	"mod+a": "all",
	"mod+backspace": "delete",
	delete: "delete",
	arrowdown: "next",
	arrowup: "prev",
	"]": "nextIssue",
	"[": "prevIssue",
	i: "issues",
	f: "fix",
	arrowright: "expand",
	arrowleft: "collapse",
	f2: "rename",
	enter: "open",
	backspace: "up",
	escape: "clear",
};

function keyAction(ev: KeyboardEvent, editing: boolean): KeyAction {
	if (editing) {
		return null;
	}
	const mod = ev.metaKey || ev.ctrlKey ? "mod+" : "";
	return KEYS[`${mod}${ev.key.toLowerCase()}`] ?? null;
}

interface PaneActionSet {
	open: (r: TreeRow) => unknown;
	rename: (path: string) => unknown;
	newFolder: (parent: string) => unknown;
	cut: (paths: string[]) => unknown;
	copy: (paths: string[]) => unknown;
	paste: (dest: string) => unknown;
	remove: (paths: string[]) => unknown;
	moveToOther: (paths: string[]) => unknown;
	fix: (paths: string[]) => unknown;
	editTags: (r: TreeRow) => unknown;
	copyTags: (r: TreeRow) => unknown;
	pasteTags: (paths: string[]) => unknown;
}

const DETAIL_MAX = 5;

/** The tags a paste onto this target would apply, one `Label: value` line each. */
function pasteSummary(clip: TagClipboard, isDir: boolean): string[] {
	const applied = Object.entries(forTarget(clip.values, isDir));
	const lines = applied.slice(0, DETAIL_MAX).map(([id, v]) => `${labelOf(id)}: ${v}`);
	if (applied.length > DETAIL_MAX) {
		lines.push(`+${applied.length - DETAIL_MAX} more`);
	}
	const skipped = Object.keys(clip.values).length - applied.length;
	if (skipped > 0) {
		lines.push(`${skipped} song-only ${skipped === 1 ? "tag" : "tags"} skipped on folders`);
	}
	return lines;
}

/** Edit / copy / paste tag entries; only for songs and folders. */
function tagItems(
	a: PaneActionSet,
	entry: TreeRow | undefined,
	paths: string[],
	clip: TagClipboard | null,
): MenuItem[] {
	if (!entry || !(entry.entry.isDir || isAudioName(entry.entry.name))) {
		return [];
	}
	const single = paths.length <= 1;
	const items: MenuItem[] = [];
	if (single) {
		items.push({
			label: entry.entry.isDir ? "Edit tags for all songs…" : "Edit tags…",
			icon: Tags,
			run: () => a.editTags(entry),
		});
		items.push({ label: "Copy tags…", icon: Copy, run: () => a.copyTags(entry) });
	}
	if (clip) {
		items.push({
			label: "Paste tags",
			icon: ClipboardPaste,
			detail: pasteSummary(clip, entry.entry.isDir),
			run: () => a.pasteTags(paths),
		});
	}
	return items;
}

/** Right-click menu entries for `entry` (or for empty space when there is none). */
function buildMenu(
	ctx: {
		actions: PaneActionSet;
		hasClipboard: boolean;
		tagClipboard: TagClipboard | null;
		canMoveToOther: boolean;
		fixing: boolean;
	},
	target: { entry?: TreeRow; paths: string[]; dest: string; fixable: number },
): MenuItem[] {
	const { actions: a } = ctx;
	const { entry, paths, dest } = target;
	const items: MenuItem[] = [];
	if (entry?.entry.isDir) {
		items.push({ label: "Open", icon: FolderOpen, run: () => a.open(entry) });
	}
	if (entry && target.fixable > 0) {
		items.push({
			label: entry.entry.isDir ? `Fix issues inside (${target.fixable})` : "Fix issues",
			icon: Wrench,
			disabled: ctx.fixing,
			run: () => a.fix(paths),
		});
	}
	items.push(...tagItems(a, entry, paths, ctx.tagClipboard));
	if (entry) {
		items.push({ label: "Rename", icon: Pencil, shortcut: "F2", run: () => a.rename(entry.path) });
		items.push({ label: "Cut", icon: Scissors, shortcut: "⌘X", run: () => a.cut(paths) });
		items.push({ label: "Copy", icon: Copy, shortcut: "⌘C", run: () => a.copy(paths) });
	}
	items.push({
		label: "Paste",
		icon: ClipboardPaste,
		shortcut: "⌘V",
		disabled: !ctx.hasClipboard,
		run: () => a.paste(dest),
	});
	items.push({
		label: "New folder",
		icon: FolderPlus,
		shortcut: "⌘N",
		run: () => a.newFolder(dest),
	});
	if (entry && ctx.canMoveToOther) {
		items.push({ label: "Move to other pane", icon: ArrowRight, run: () => a.moveToOther(paths) });
	}
	if (entry) {
		items.push({
			label: "Delete",
			icon: Trash2,
			shortcut: "⌫",
			danger: true,
			run: () => a.remove(paths),
		});
	}
	return items;
}

function Thumb({ src, children }: { src: string; children: React.ReactNode }) {
	const [failed, setFailed] = useState(false);
	if (failed) {
		return children;
	}
	return (
		<img
			src={src}
			alt=""
			loading="lazy"
			decoding="async"
			draggable={false}
			className="size-7 shrink-0 rounded object-cover"
			onError={() => setFailed(true)}
		/>
	);
}

/** Album art when the file or folder has any, otherwise a plain icon. */
function EntryIcon({ entry, path }: { entry: FsEntry; path?: string }) {
	const plain = (
		<span className="flex size-7 shrink-0 items-center justify-center">
			<PlainIcon entry={entry} />
		</span>
	);
	if (path === undefined || entry.isDir || !isAudioName(entry.name)) {
		return plain;
	}
	return (
		<Thumb key={path} src={pathArtUrl(path)}>
			{plain}
		</Thumb>
	);
}

function PlainIcon({ entry }: { entry: FsEntry }) {
	return entry.isDir ? (
		<Folder className="size-4 shrink-0 text-primary" />
	) : (
		<FileIcon className="size-4 shrink-0 text-muted-foreground" />
	);
}

/** Expand/collapse toggle of a folder row; files get a blank of the same width. */
function Chevron({
	entry,
	open,
	loading,
	onToggle,
}: {
	entry: FsEntry;
	open: boolean;
	loading: boolean;
	onToggle: () => void;
}) {
	if (!entry.isDir) {
		return <span className="-mx-1 size-5 shrink-0" />;
	}
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-label={open ? "Collapse" : "Expand"}
			className="-mx-1 flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted"
			onClick={(ev) => {
				ev.stopPropagation();
				onToggle();
			}}
			onDoubleClick={(ev) => ev.stopPropagation()}
		>
			<ChevronRight
				className={cn(
					"size-3.5 text-muted-foreground transition-transform",
					open && "rotate-90",
					loading && "animate-pulse",
				)}
			/>
		</button>
	);
}

function EntryRow({
	row,
	selected,
	active,
	expanded,
	isLoading,
	health,
	fixing,
	onFix,
	issueOpen,
	onIssueOpen,
	clipboard,
	dropTarget,
	onToggle,
	onDragStart,
	onClick,
	onOpen,
	onDragOver,
	onDragLeave,
	onDrop,
	menu,
	onContextMenu,
}: {
	row: TreeRow;
	selected: boolean;
	active: boolean;
	expanded: ReadonlySet<string>;
	isLoading: (dir: string) => boolean;
	health: IssueIndex;
	fixing: boolean;
	onFix: (scopes: string[]) => unknown;
	issueOpen: boolean;
	onIssueOpen: (open: boolean) => void;
	clipboard: FsClipboard | null;
	dropTarget: string | null;
	onToggle: () => void;
	onDragStart: (ev: DragEvent) => void;
	onClick: (ev: MouseEvent) => void;
	onOpen: () => void;
	onDragOver: (ev: DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (ev: DragEvent) => void;
	menu: MenuItem[];
	onContextMenu: () => void;
}) {
	const { entry, path, depth } = row;
	const open = expanded.has(path);
	const loading = open && isLoading(path);
	const dropping = dropTarget === path;
	const dimmed = clipboard?.mode === "cut" && clipboard.paths.includes(path);
	const highlight = active ? "bg-primary/25" : "bg-muted";
	return (
		<MenuShell items={menu}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled at pane level */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: selectable, draggable row */}
			<div
				data-row-path={path}
				draggable
				onDragStart={onDragStart}
				onClick={onClick}
				onDoubleClick={onOpen}
				onContextMenu={(ev) => {
					ev.stopPropagation();
					onContextMenu();
				}}
				onDragOver={entry.isDir ? onDragOver : undefined}
				onDragLeave={onDragLeave}
				onDrop={entry.isDir ? onDrop : undefined}
				style={{ paddingLeft: `${12 + depth * INDENT}px` }}
				className={cn(
					"flex cursor-default select-none items-center gap-2 py-1 pr-3 text-sm",
					selected ? highlight : "hover:bg-muted/60",
					dropping && "bg-primary/30 ring-1 ring-primary ring-inset",
					dimmed && "opacity-50",
				)}
			>
				<Chevron entry={entry} open={open} loading={loading} onToggle={onToggle} />
				<EntryIcon entry={entry} path={path} />
				<span className="min-w-0 flex-1 truncate">{entry.name}</span>
				<IssuePopover
					path={path}
					isDir={entry.isDir}
					health={health}
					fixing={fixing}
					onFix={onFix}
					open={issueOpen}
					onOpenChange={onIssueOpen}
				/>
				{!entry.isDir && <span className="text-muted-foreground text-xs">{size(entry.size)}</span>}
			</div>
		</MenuShell>
	);
}

interface MenuItem {
	label: string;
	icon: typeof Pencil;
	run: () => unknown;
	shortcut?: string;
	disabled?: boolean;
	danger?: boolean;
	/** Muted lines under the label, e.g. the tags a paste would apply. */
	detail?: string[];
}

const popup =
	"z-50 min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground text-sm shadow-lg outline-none";
const menuItem =
	"flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-muted";

/** Right-click menu around a single child element. */
function MenuShell({ items, children }: { items: MenuItem[]; children: React.ReactElement }) {
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger render={children} />
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50">
					<ContextMenu.Popup className={popup}>
						{items.map(({ label, icon: Icon, run, shortcut, disabled, danger, detail }) => (
							<ContextMenu.Item
								key={label}
								className={cn(menuItem, danger && "text-destructive")}
								disabled={disabled}
								onClick={run}
							>
								<Icon className={cn("size-4", detail && "self-start mt-0.5")} />
								<span className="min-w-0 flex-1">
									{label}
									{detail?.map((line) => (
										<span
											key={line}
											className="block max-w-64 truncate text-muted-foreground text-xs"
										>
											{line}
										</span>
									))}
								</span>
								{shortcut && <span className="text-muted-foreground text-xs">{shortcut}</span>}
							</ContextMenu.Item>
						))}
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}

function NameRow({
	depth,
	icon,
	initial,
	placeholder,
	onSubmit,
	onCancel,
}: {
	depth: number;
	icon: React.ReactNode;
	initial: string;
	placeholder?: string;
	onSubmit: (name: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(initial);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const el = ref.current;
		el?.focus();
		// Select the name without its extension, like Finder.
		const dot = initial.lastIndexOf(".");
		el?.setSelectionRange(0, dot > 0 ? dot : initial.length);
	}, [initial]);

	const submit = () => {
		const name = value.trim();
		if (name === "") {
			onCancel();
		} else {
			onSubmit(name);
		}
	};

	return (
		<form
			style={{ paddingLeft: `${8 + depth * INDENT}px` }}
			className="flex items-center gap-2 py-0.5 pr-2"
			onSubmit={(ev) => {
				ev.preventDefault();
				submit();
			}}
		>
			{icon}
			<Input
				ref={ref}
				value={value}
				placeholder={placeholder}
				className="h-7"
				onChange={(ev) => setValue(ev.target.value)}
				onKeyDown={(ev) => {
					ev.stopPropagation();
					if (ev.key === "Escape") {
						onCancel();
					}
				}}
				onBlur={onCancel}
			/>
		</form>
	);
}
