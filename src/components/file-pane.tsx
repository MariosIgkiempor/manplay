import { ContextMenu } from "@base-ui/react/context-menu";
import {
	ArrowDown,
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
	FolderSearch,
	Keyboard,
	Pause,
	Pencil,
	Play,
	Scissors,
	Search,
	Square,
	Tags,
	Trash2,
	Wrench,
	X,
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
import type { UndoEntry } from "#/context/undo-context.ts";
import { type FsEntry, fsReveal, pathArtUrl } from "#/lib/api.ts";
import type { IssueIndex } from "#/lib/audit.ts";
import { isAudioName, joinPath, parentPath, relSegments } from "#/lib/fs-path.ts";
import { applyClick, EMPTY_SELECTION, type Selection } from "#/lib/selection.ts";
import { forTarget, type TagClipboard } from "#/lib/tag-clipboard.ts";
import { labelOf } from "#/lib/tag-preview.ts";
import {
	type FileSort,
	type FileSortKey,
	filterRows,
	nameMatches,
	type TreeRow,
} from "#/lib/tree.ts";
import { useFileDrag } from "#/lib/use-file-drag.ts";
import { useFilePlay } from "#/lib/use-file-play.ts";
import type { FsClipboard } from "#/lib/use-fs-ops.ts";
import { useFsOps } from "#/lib/use-fs-ops.ts";
import { undoMakeDir, undoRename } from "#/lib/use-fs-undo.ts";
import { useIssueNav } from "#/lib/use-issue-nav.ts";
import { useTree } from "#/lib/use-tree.ts";
import { expandOrEnter, useVimNav } from "#/lib/use-vim-nav.ts";
import { cn } from "#/lib/utils.ts";

/** Tells the tag pane about a newly selected song or folder (other files are ignored). */
function useReportTarget(row: TreeRow | undefined, report: PaneProps["onSelectTarget"]) {
	const reportRef = useRef(report);
	reportRef.current = report;
	const path = row?.path;
	const name = row?.entry.name;
	const isDir = row?.entry.isDir;
	useEffect(() => {
		if (path !== undefined && name !== undefined && (isDir || isAudioName(name))) {
			reportRef.current({ path, name, isDir: isDir ?? false });
		}
	}, [path, name, isDir]);
}

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
	/** Moves keyboard focus to the tag editor (vim `L`). */
	onFocusTags: () => void;
	/** How both panes order their rows. */
	sort: FileSort;
	onSort: (sort: FileSort) => void;
	/** Opens the keyboard shortcut sheet (`?`). */
	onShowShortcuts: () => void;
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
	onFocusTags,
	sort,
	onSort,
	onShowShortcuts,
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
	} = useTree(path, sort);
	/** Text in the filter box; rows that do not match are hidden. */
	const [query, setQuery] = useState("");
	const filterRef = useRef<HTMLInputElement>(null);
	const shown = filterRows(rows, query);
	const visible = shown.map((r) => r.path);
	const player = useFilePlay();

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
		setQuery("");
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

	const isSong = (r: TreeRow) => !r.entry.isDir && isAudioName(r.entry.name);
	const play = (r: TreeRow) => isSong(r) && player.toggle(shown, r.path);
	/** Folders open in place (chevron); double-click and Enter go into them, or play a song. */
	const enter = (r: TreeRow) => (r.entry.isDir ? onNavigate(r.path) : play(r));
	const playStateOf = (p: string): PlayState =>
		player.current !== p ? null : player.playing ? "playing" : "paused";
	const reveal = (p: string) => void fsReveal(p).catch((e) => setError(String(e)));

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
	useReportTarget(onlySelected, onSelectTarget);
	const keyboardDest = onlySelected?.entry.isDir ? onlySelected.path : path;

	const actions: PaneActionSet = {
		open: (r) => enter(r),
		play: (r) => play(r),
		reveal: (p) => reveal(p),
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

	const jumpTo = (p: string | null | undefined) => {
		if (p === undefined || p === null) {
			return;
		}
		setSel({ selected: new Set([p]), anchor: p });
		requestAnimationFrame(() =>
			document
				.querySelector(`[data-row-path="${CSS.escape(p)}"]`)
				?.scrollIntoView({ block: "nearest" }),
		);
	};

	const currentRow = sel.anchor ?? onlySelected?.path ?? null;
	const nav = useVimNav({ rows: shown, current: currentRow, jumpTo, query });
	const focusPane = () => requestAnimationFrame(() => sectionRef.current?.focus());

	/** Enter goes to the first match; Escape clears the filter. Either way, back to the list. */
	const finishFilter = (keep: boolean) => {
		if (keep) {
			jumpTo(shown.find((r) => nameMatches(r.entry.name, query))?.path);
		} else {
			setQuery("");
		}
		focusPane();
	};

	const onKeyDown = (ev: KeyboardEvent) => {
		const action = keyAction(ev, renaming !== null || creatingIn !== null);
		if (action !== "g") {
			nav.resetG();
		}
		if (action === null) {
			return;
		}
		const run: Record<Exclude<KeyAction, null>, () => unknown> = {
			rename: () => onlySelected && setRenaming(onlySelected.path),
			open: () => onlySelected && enter(onlySelected),
			up: () => !atRoot && onNavigate(parentPath(path)),
			all: () => setSel({ selected: new Set(visible), anchor: null }),
			// Escape drops the selection first, then the filter.
			clear: () => (selected.size > 0 ? setSel(EMPTY_SELECTION) : setQuery("")),
			play: () => onlySelected && play(onlySelected),
			help: onShowShortcuts,
			newFolder: () => actions.newFolder(keyboardDest),
			cut: () => actions.cut(pathsOf()),
			copy: () => actions.copy(pathsOf()),
			paste: () => actions.paste(keyboardDest),
			delete: () => actions.remove(pathsOf()),
			...issueNav.keys,
			expand: () => onlySelected?.entry.isDir && setOpen(onlySelected.path, true),
			expandIn: () => expandOrEnter(onlySelected, rows, expanded, setOpen, jumpTo),
			top: () => jumpTo(visible[0]),
			bottom: () => jumpTo(visible[visible.length - 1]),
			g: () => nav.g(() => jumpTo(visible[0])),
			search: () => filterRef.current?.select(),
			searchNext: () => nav.stepSearch(1),
			searchPrev: () => nav.stepSearch(-1),
			focusTags: onFocusTags,
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
	const selectedBytes = selectedPaths.reduce(
		(sum, p) => sum + (rowByPath.get(p)?.entry.size ?? 0),
		0,
	);
	const filtering = query.trim() !== "";
	/** Rows matching the filter, `null` when not filtering. */
	const matches = filtering ? shown.filter((r) => nameMatches(r.entry.name, query)).length : null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pane-level keyboard shortcuts
		<section
			ref={sectionRef}
			data-file-pane
			tabIndex={-1}
			className={cn(
				"@container/pane flex min-h-0 min-w-0 flex-1 flex-col border-r bg-card/40 outline-none last:border-r-0",
				active && "bg-card/70",
			)}
			onKeyDown={onKeyDown}
			onMouseDown={(ev) => {
				onActivate();
				focusUnlessTyping(ev);
			}}
		>
			<div className="flex items-center gap-1 border-b px-2 py-1.5">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Up one folder (⌫)"
					title="Up one folder (⌫)"
					disabled={atRoot}
					onClick={() => onNavigate(parentPath(path))}
				>
					<ArrowUp />
				</Button>
				<Breadcrumbs root={root} crumbs={crumbs} drag={drag} onNavigate={onNavigate} />
				<PaneActions
					busy={busy}
					count={selected.size}
					hasClipboard={clipboard !== null}
					split={otherPath !== null}
					canMove={movable}
					onNewFolder={() => actions.newFolder(keyboardDest)}
					onRename={() => setRenaming(selectedPaths[0] ?? null)}
					onCut={() => actions.cut(selectedPaths)}
					onCopy={() => actions.copy(selectedPaths)}
					onPaste={() => actions.paste(keyboardDest)}
					onTrash={() => actions.remove(selectedPaths)}
					onToggleSplit={onToggleSplit}
					onMove={() => otherPath !== null && runMove(selectedPaths, otherPath)}
				/>
			</div>

			<FilterBox
				inputRef={filterRef}
				value={query}
				matches={matches ?? 0}
				onChange={setQuery}
				onDone={finishFilter}
			/>
			<Banners error={error} listError={listing?.isError ? String(listing.error) : null} />
			<ColumnHeader sort={sort} onSort={onSort} />

			<MenuShell items={paneMenu}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for the current folder */}
				<div
					className={cn(
						"min-h-0 flex-1 overflow-y-auto py-0.5",
						drag.dropTarget === path && "bg-primary/10",
					)}
					onDragOver={(ev) => drag.allowDrop(ev, path)}
					onDragLeave={drag.clearDrop}
					onDrop={(ev) => drag.dropInto(ev, path)}
				>
					{creatingIn === path && newFolderRow(path, 0)}
					{shown.flatMap((r) => {
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
									query={query}
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
									playState={playStateOf(r.path)}
									onPlay={isSong(r) ? () => play(r) : undefined}
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
					<PaneEmpty
						empty={listing?.isSuccess === true && listed.length === 0 && creatingIn !== path}
						noMatch={matches === 0}
						query={query}
						onNewFolder={() => actions.newFolder(path)}
						onClearFilter={() => setQuery("")}
					/>
				</div>
			</MenuShell>
			<PaneFooter
				count={listed.length}
				matches={matches}
				selected={selected.size}
				bytes={selectedBytes}
				onShowShortcuts={onShowShortcuts}
			/>
		</section>
	);
}

/** Counts for the pane and the shortcut sheet button. */
function PaneFooter({
	count,
	matches,
	selected,
	bytes,
	onShowShortcuts,
}: {
	count: number;
	/** Rows matching the filter, `null` when not filtering. */
	matches: number | null;
	selected: number;
	bytes: number;
	onShowShortcuts: () => void;
}) {
	const items =
		matches === null ? `${count} item${count === 1 ? "" : "s"}` : `${matches} matching`;
	const picked =
		selected > 0 ? ` · ${selected} selected${bytes > 0 ? ` (${size(bytes)})` : ""}` : "";
	return (
		<div className="flex items-center gap-2 border-t px-3 py-1 text-muted-foreground text-xs tabular-nums">
			<span className="min-w-0 flex-1 truncate">
				{items}
				{picked}
			</span>
			<button
				type="button"
				onClick={onShowShortcuts}
				title="Keyboard shortcuts (?)"
				className="-mr-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
			>
				<Keyboard />
				<span className="hidden @md/pane:inline">Shortcuts</span>
			</button>
		</div>
	);
}

/** Always-visible filter; `/` jumps into it, Enter goes back to the list, Escape clears it. */
function FilterBox({
	inputRef,
	value,
	matches,
	onChange,
	onDone,
}: {
	inputRef: React.RefObject<HTMLInputElement | null>;
	value: string;
	matches: number;
	onChange: (v: string) => void;
	onDone: (keep: boolean) => void;
}) {
	const on = value.trim() !== "";
	return (
		<div className="flex items-center gap-2 border-b px-3">
			<Search
				className={cn("size-3.5 shrink-0", on ? "text-primary" : "text-muted-foreground/70")}
			/>
			<input
				ref={inputRef}
				value={value}
				placeholder="Filter by name"
				aria-label="Filter by name"
				spellCheck={false}
				className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
				onChange={(ev) => onChange(ev.target.value)}
				onKeyDown={(ev) => {
					ev.stopPropagation();
					if (ev.key === "Enter" || ev.key === "Escape" || ev.key === "ArrowDown") {
						ev.preventDefault();
						onDone(ev.key !== "Escape");
					}
				}}
			/>
			{on ? (
				<>
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{matches === 0 ? "No matches" : `${matches} found`}
					</span>
					<button
						type="button"
						aria-label="Clear filter"
						title="Clear filter (Esc)"
						onClick={() => onDone(false)}
						className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<X className="size-3.5" />
					</button>
				</>
			) : (
				<kbd className="hidden shrink-0 rounded border px-1.5 text-[11px] text-muted-foreground/70 @sm/pane:inline">
					/
				</kbd>
			)}
		</div>
	);
}

/** Shared widths so the header and every row line up. */
const DATE_COL = "hidden w-28 shrink-0 text-right @lg/pane:block";
const SIZE_COL = "w-16 shrink-0 text-right";

const SORT_COLUMNS: { key: FileSortKey; label: string; className: string; desc: boolean }[] = [
	{ key: "name", label: "Name", className: "min-w-0 flex-1 text-left", desc: false },
	{ key: "modified", label: "Modified", className: DATE_COL, desc: true },
	{ key: "size", label: "Size", className: SIZE_COL, desc: true },
];

/** Column names that sort when clicked; clicking the sorted one flips it. */
function ColumnHeader({ sort, onSort }: { sort: FileSort; onSort: (s: FileSort) => void }) {
	return (
		<div className="flex h-7 items-center gap-2 border-b pr-3 pl-[72px] text-muted-foreground text-xs">
			{SORT_COLUMNS.map((c) => {
				const on = sort.key === c.key;
				const Arrow = sort.desc ? ArrowDown : ArrowUp;
				return (
					<button
						key={c.key}
						type="button"
						title={`Sort by ${c.label.toLowerCase()}`}
						aria-pressed={on}
						onClick={() =>
							onSort(on ? { key: c.key, desc: !sort.desc } : { key: c.key, desc: c.desc })
						}
						className={cn(c.className, "group/col hover:text-foreground", on && "text-foreground")}
					>
						<span
							className={cn(
								"inline-flex items-center gap-1",
								c.key !== "name" && "flex-row-reverse",
							)}
						>
							{c.label}
							<Arrow
								className={cn("size-3", on ? "opacity-70" : "opacity-0 group-hover/col:opacity-40")}
							/>
						</span>
					</button>
				);
			})}
		</div>
	);
}

/** The empty-folder or no-matches note, when the list shows nothing. */
function PaneEmpty({
	empty,
	noMatch,
	query,
	onNewFolder,
	onClearFilter,
}: {
	empty: boolean;
	noMatch: boolean;
	query: string;
	onNewFolder: () => void;
	onClearFilter: () => void;
}) {
	if (empty) {
		return <EmptyNote title="This folder is empty" action="New folder" onAction={onNewFolder} />;
	}
	if (noMatch) {
		return (
			<EmptyNote
				title={`Nothing here matches “${query.trim()}”`}
				hint="The filter looks at this folder and any folders you have open."
				action="Clear filter"
				onAction={onClearFilter}
			/>
		);
	}
	return null;
}

/** What an empty list means and the one thing to do about it. */
function EmptyNote({
	title,
	hint,
	action,
	onAction,
}: {
	title: string;
	hint?: string;
	action: string;
	onAction: () => void;
}) {
	return (
		<div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
			<p className="text-sm">{title}</p>
			{hint && <p className="max-w-64 text-muted-foreground text-xs">{hint}</p>}
			<Button variant="outline" size="sm" className="mt-2" onClick={onAction}>
				{action}
			</Button>
		</div>
	);
}

function Banners({ error, listError }: { error: string | null; listError: string | null }) {
	return (
		<>
			{error && (
				<p className="border-b bg-destructive/10 px-3 py-1.5 text-destructive text-xs">{error}</p>
			)}
			{listError && (
				<ErrorText className="px-3 py-2 text-destructive text-sm" message={listError} />
			)}
		</>
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
				className="rounded-md px-1 font-medium hover:bg-muted"
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
							className={cn("rounded-md px-1 hover:bg-muted", dropTarget === to && "bg-primary/20")}
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

/** An icon button whose tooltip names the shortcut. */
function Tool({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</Button>
	);
}

const Divider = () => <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />;

function PaneActions({
	busy,
	count,
	hasClipboard,
	split,
	canMove,
	onNewFolder,
	onRename,
	onCut,
	onCopy,
	onPaste,
	onTrash,
	onToggleSplit,
	onMove,
}: {
	busy: boolean;
	count: number;
	hasClipboard: boolean;
	split: boolean;
	canMove: boolean;
	onNewFolder: () => void;
	onRename: () => void;
	onCut: () => void;
	onCopy: () => void;
	onPaste: () => void;
	onTrash: () => void;
	onToggleSplit: () => void;
	onMove: () => void;
}) {
	const none = busy || count === 0;
	return (
		<div className="flex shrink-0 items-center">
			<Tool label="New folder (⌘N)" disabled={busy} onClick={onNewFolder}>
				<FolderPlus />
			</Tool>
			<Tool label="Rename (F2)" disabled={busy || count !== 1} onClick={onRename}>
				<Pencil />
			</Tool>
			{/* Clipboard tools fold away when the pane is narrow; the keys and menu still work. */}
			<div className="hidden items-center @xl/pane:flex">
				<Divider />
				<Tool label="Cut (⌘X)" disabled={none} onClick={onCut}>
					<Scissors />
				</Tool>
				<Tool label="Copy (⌘C)" disabled={none} onClick={onCopy}>
					<Copy />
				</Tool>
				<Tool label="Paste (⌘V)" disabled={busy || !hasClipboard} onClick={onPaste}>
					<ClipboardPaste />
				</Tool>
			</div>
			<Tool label="Move to Trash (⌘⌫)" disabled={none} onClick={onTrash}>
				<Trash2 />
			</Tool>
			<Divider />
			{split && (
				<Tool label="Move selection to the other pane" disabled={none || !canMove} onClick={onMove}>
					<ArrowRight />
				</Tool>
			)}
			<Tool label={split ? "Single pane" : "Split panes"} onClick={onToggleSplit}>
				{split ? <Square /> : <Columns2 />}
			</Tool>
		</div>
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
	| "expandIn"
	| "top"
	| "bottom"
	| "g"
	| "search"
	| "searchNext"
	| "searchPrev"
	| "focusTags"
	| "next"
	| "prev"
	| "nextIssue"
	| "prevIssue"
	| "issues"
	| "fix"
	| "play"
	| "help"
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
	" ": "play",
	"?": "help",
	// Vim keys
	j: "next",
	k: "prev",
	l: "expandIn",
	h: "collapse",
	H: "collapse",
	L: "focusTags",
	r: "rename",
	d: "delete",
	y: "copy",
	x: "cut",
	p: "paste",
	a: "newFolder",
	o: "open",
	"-": "up",
	g: "g",
	G: "bottom",
	"/": "search",
	n: "searchNext",
	N: "searchPrev",
};

function keyAction(ev: KeyboardEvent, editing: boolean): KeyAction {
	const t = ev.target;
	if (editing || ev.altKey || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
		return null;
	}
	const hasMod = ev.metaKey || ev.ctrlKey;
	// Vim letters are case-sensitive (`L` differs from `l`) and never fire with ⌘/Ctrl held.
	const exact = hasMod ? undefined : KEYS[ev.key];
	return exact ?? KEYS[`${hasMod ? "mod+" : ""}${ev.key.toLowerCase()}`] ?? null;
}

interface PaneActionSet {
	open: (r: TreeRow) => unknown;
	play: (r: TreeRow) => unknown;
	reveal: (path: string) => unknown;
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
		lines.push(`${skipped} song-only ${skipped === 1 ? "field" : "fields"} skipped on folders`);
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
			label: entry.entry.isDir ? "Edit metadata for all songs…" : "Edit metadata…",
			icon: Tags,
			run: () => a.editTags(entry),
		});
		items.push({ label: "Copy metadata…", icon: Copy, run: () => a.copyTags(entry) });
	}
	if (clip) {
		items.push({
			label: "Paste metadata",
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
		items.push({ label: "Open", icon: FolderOpen, shortcut: "↩", run: () => a.open(entry) });
	} else if (entry && isAudioName(entry.entry.name)) {
		items.push({ label: "Play", icon: Play, shortcut: "Space", run: () => a.play(entry) });
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
	items.push({
		label: entry ? "Show in Finder" : "Show this folder in Finder",
		icon: FolderSearch,
		run: () => a.reveal(entry?.path ?? dest),
	});
	if (entry && ctx.canMoveToOther) {
		items.push({ label: "Move to other pane", icon: ArrowRight, run: () => a.moveToOther(paths) });
	}
	if (entry) {
		items.push({
			label: "Move to Trash",
			icon: Trash2,
			shortcut: "⌘⌫",
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
			className="size-7 shrink-0 rounded-md object-cover"
			onError={() => setFailed(true)}
		/>
	);
}

/**
 * A song's cover with a play button over it on hover, and a steady pause / play mark while it is
 * the one loaded in the player.
 */
function SongIcon({
	entry,
	path,
	state,
	onPlay,
}: {
	entry: FsEntry;
	path: string;
	state: PlayState;
	onPlay: () => void;
}) {
	const Glyph = state === "playing" ? Pause : Play;
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-label={state === "playing" ? `Pause ${entry.name}` : `Play ${entry.name}`}
			onClick={(ev) => {
				ev.stopPropagation();
				onPlay();
			}}
			onDoubleClick={(ev) => ev.stopPropagation()}
			className="relative size-7 shrink-0 rounded-md"
		>
			<EntryIcon entry={entry} path={path} />
			<span
				className={cn(
					"absolute inset-0 grid place-items-center rounded-md bg-black/55 text-white transition-opacity",
					state ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
				)}
			>
				<Glyph className="size-3.5 fill-current" />
			</span>
		</button>
	);
}

type PlayState = "playing" | "paused" | null;

/** The name with the filtered-for part marked. */
function Name({ name, query }: { name: string; query: string }) {
	const q = query.trim().toLowerCase();
	const at = q === "" ? -1 : name.toLowerCase().indexOf(q);
	if (at === -1) {
		return <>{name}</>;
	}
	return (
		<>
			{name.slice(0, at)}
			<mark className="rounded-sm bg-primary/25 text-inherit">{name.slice(at, at + q.length)}</mark>
			{name.slice(at + q.length)}
		</>
	);
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Today's changes by time, older ones by date. */
function modifiedLabel(unix: number | null): string {
	if (unix === null) {
		return "–";
	}
	const d = new Date(unix * 1000);
	return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dateFmt.format(d);
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
			className="-mx-1 flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-muted"
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
	query,
	playState,
	onPlay,
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
	query: string;
	playState: PlayState;
	/** Set for songs. */
	onPlay: (() => void) | undefined;
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
					"group/row mx-1 flex cursor-default select-none items-center gap-2 rounded-md py-1 pr-2 text-sm",
					selected ? highlight : "hover:bg-muted/60",
					dropping && "bg-primary/30 ring-1 ring-primary ring-inset",
					dimmed && "opacity-50",
				)}
			>
				<Chevron entry={entry} open={open} loading={loading} onToggle={onToggle} />
				{onPlay ? (
					<SongIcon entry={entry} path={path} state={playState} onPlay={onPlay} />
				) : (
					<EntryIcon entry={entry} path={path} />
				)}
				<span
					className={cn("min-w-0 flex-1 truncate", playState && "font-medium text-primary")}
					title={entry.name}
				>
					<Name name={entry.name} query={query} />
				</span>
				<IssuePopover
					path={path}
					isDir={entry.isDir}
					health={health}
					fixing={fixing}
					onFix={onFix}
					open={issueOpen}
					onOpenChange={onIssueOpen}
				/>
				<span className={cn(DATE_COL, "text-muted-foreground text-xs tabular-nums")}>
					{modifiedLabel(entry.modified)}
				</span>
				<span className={cn(SIZE_COL, "text-muted-foreground text-xs tabular-nums")}>
					{entry.isDir ? <span className="opacity-40">–</span> : size(entry.size)}
				</span>
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
