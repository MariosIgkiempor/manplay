import { ContextMenu } from "@base-ui/react/context-menu";
import { useQuery } from "@tanstack/react-query";
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
	Trash2,
} from "lucide-react";
import {
	type DragEvent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { confirmTrash, type FsEntry, fsList, pathArtUrl } from "#/lib/api.ts";
import { isAudioName, joinPath, parentPath, relSegments } from "#/lib/fs-path.ts";
import { useFsCopy, useFsMakeDir, useFsMove, useFsRename, useFsTrash } from "#/lib/queries.ts";
import { applyClick, EMPTY_SELECTION, type Selection } from "#/lib/selection.ts";
import { cn } from "#/lib/utils.ts";

const DRAG_TYPE = "application/x-manplay-paths";

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

/** Cut/copied items waiting to be pasted; shared by both panes. */
export interface FsClipboard {
	mode: "cut" | "copy";
	paths: string[];
}

interface PaneProps {
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
}

export function FilePane({
	clipboard,
	setClipboard,
	root,
	path,
	onNavigate,
	active,
	onActivate,
	otherPath,
	onToggleSplit,
}: PaneProps) {
	const listing = useQuery({ queryKey: ["fs", path], queryFn: () => fsList(path) });
	const entries = useMemo(() => listing.data ?? [], [listing.data]);
	const names = useMemo(() => entries.map((e) => e.name), [entries]);

	const [sel, setSel] = useState<Selection<string>>(EMPTY_SELECTION);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const makeDir = useFsMakeDir();
	const rename = useFsRename();
	const move = useFsMove();
	const copy = useFsCopy();
	const trash = useFsTrash();
	const busy =
		makeDir.isPending || rename.isPending || move.isPending || copy.isPending || trash.isPending;

	// A new folder, or a refresh that drops names, must not leave stale selections behind.
	const selected = useMemo(
		() => new Set([...sel.selected].filter((n) => names.includes(n))),
		[sel.selected, names],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the folder changes
	useEffect(() => {
		setSel(EMPTY_SELECTION);
		setRenaming(null);
		setCreating(false);
		setError(null);
	}, [path]);

	const fail = (e: unknown) => setError(String(e));
	const atRoot = path === root;
	const crumbs = relSegments(root, path);

	const runMove = (paths: string[], dest: string) => {
		setError(null);
		move.mutate({ paths, dest }, { onError: fail, onSuccess: () => setSel(EMPTY_SELECTION) });
	};

	const open = (e: FsEntry) => e.isDir && onNavigate(joinPath(path, e.name));

	const onRowClick = (
		e: FsEntry,
		ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
	) => {
		onActivate();
		setSel((prev) =>
			applyClick(prev, names, e.name, { shift: ev.shiftKey, toggle: ev.metaKey || ev.ctrlKey }),
		);
	};

	const pathsOf = (e?: FsEntry) =>
		(e && !selected.has(e.name) ? [e.name] : [...selected]).map((n) => joinPath(path, n));

	const actions: PaneActionSet = {
		open: (e) => open(e),
		rename: (name) => setRenaming(name),
		newFolder: () => setCreating(true),
		cut: (paths) => paths.length > 0 && setClipboard({ mode: "cut", paths }),
		copy: (paths) => paths.length > 0 && setClipboard({ mode: "copy", paths }),
		paste: (dest) => {
			if (clipboard === null) {
				return;
			}
			setError(null);
			if (clipboard.mode === "copy") {
				copy.mutate({ paths: clipboard.paths, dest }, { onError: fail });
			} else {
				move.mutate(
					{ paths: clipboard.paths, dest },
					{ onError: fail, onSuccess: () => setClipboard(null) },
				);
			}
		},
		remove: async (paths) => {
			if (
				paths.length === 0 ||
				!(await confirmTrash(paths.map((p) => p.split(/[\\/]/).pop() ?? p)))
			) {
				return;
			}
			setError(null);
			trash.mutate(paths, { onError: fail, onSuccess: () => setSel(EMPTY_SELECTION) });
		},
		moveToOther: (paths) => otherPath !== null && runMove(paths, otherPath),
	};

	const onKeyDown = (ev: KeyboardEvent) => {
		const action = keyAction(ev, renaming !== null || creating);
		if (action === null) {
			return;
		}
		const only = selected.size === 1 ? entries.find((e) => selected.has(e.name)) : undefined;
		const run: Record<Exclude<KeyAction, null>, () => unknown> = {
			rename: () => only && setRenaming(only.name),
			open: () => only && open(only),
			up: () => !atRoot && onNavigate(parentPath(path)),
			all: () => setSel({ selected: new Set(names), anchor: null }),
			clear: () => setSel(EMPTY_SELECTION),
			newFolder: () => setCreating(true),
			cut: () => actions.cut(pathsOf()),
			copy: () => actions.copy(pathsOf()),
			paste: () => actions.paste(path),
			delete: () => actions.remove(pathsOf()),
		};
		ev.preventDefault();
		run[action]();
	};

	const dragStart = (ev: DragEvent, e: FsEntry) => {
		const dragged = selected.has(e.name) ? [...selected] : [e.name];
		if (!selected.has(e.name)) {
			setSel({ selected: new Set([e.name]), anchor: e.name });
		}
		ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged.map((n) => joinPath(path, n))));
		ev.dataTransfer.effectAllowed = "move";
	};

	const dropInto = (ev: DragEvent, dest: string) => {
		ev.preventDefault();
		ev.stopPropagation();
		setDropTarget(null);
		const raw = ev.dataTransfer.getData(DRAG_TYPE);
		if (raw === "") {
			return;
		}
		const paths = (JSON.parse(raw) as string[]).filter((p) => p !== dest);
		if (paths.length > 0) {
			runMove(paths, dest);
		}
	};

	const allowDrop = (ev: DragEvent, key: string) => {
		if (ev.dataTransfer.types.includes(DRAG_TYPE)) {
			ev.preventDefault();
			ev.stopPropagation();
			setDropTarget(key);
		}
	};

	const submitRename = (e: FsEntry, newName: string) => {
		if (newName === e.name) {
			setRenaming(null);
			return;
		}
		rename.mutate(
			{ path: joinPath(path, e.name), newName },
			{
				onError: fail,
				onSuccess: () => {
					setRenaming(null);
					setSel({ selected: new Set([newName]), anchor: newName });
				},
			},
		);
	};

	const menuCtx = {
		actions,
		hasClipboard: clipboard !== null,
		canMoveToOther: otherPath !== null && otherPath !== path,
	};
	const menuFor = (e: FsEntry) =>
		buildMenu(menuCtx, {
			entry: e,
			paths: pathsOf(e),
			dest: e.isDir ? joinPath(path, e.name) : path,
		});
	const paneMenu = buildMenu(menuCtx, { paths: [], dest: path });
	const selectForMenu = (e: FsEntry) => {
		onActivate();
		if (!selected.has(e.name)) {
			setSel({ selected: new Set([e.name]), anchor: e.name });
		}
	};

	const selectedPaths = [...selected].map((n) => joinPath(path, n));

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pane-level keyboard shortcuts
		<section
			className={cn(
				"flex min-h-0 min-w-0 flex-1 flex-col border-r bg-card/40 last:border-r-0",
				active && "bg-card/70",
			)}
			onKeyDown={onKeyDown}
			onMouseDown={onActivate}
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
				<nav className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-sm">
					<button
						type="button"
						className="rounded px-1 font-medium hover:bg-muted"
						onClick={() => onNavigate(root)}
						onDragOver={(ev) => allowDrop(ev, root)}
						onDragLeave={() => setDropTarget(null)}
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
									className={cn(
										"rounded px-1 hover:bg-muted",
										dropTarget === to && "bg-primary/20",
									)}
									onClick={() => onNavigate(to)}
									onDragOver={(ev) => allowDrop(ev, to)}
									onDragLeave={() => setDropTarget(null)}
									onDrop={(ev) => dropInto(ev, to)}
								>
									{seg}
								</button>
							</span>
						);
					})}
				</nav>
				<PaneActions
					busy={busy}
					count={selected.size}
					split={otherPath !== null}
					canMove={otherPath !== null && otherPath !== path}
					onNewFolder={() => setCreating(true)}
					onRename={() => setRenaming([...selected][0] ?? null)}
					onToggleSplit={onToggleSplit}
					onMove={() => otherPath !== null && runMove(selectedPaths, otherPath)}
				/>
			</div>

			{error && (
				<p className="border-b bg-destructive/10 px-3 py-1.5 text-destructive text-xs">{error}</p>
			)}
			{listing.isError && (
				<p className="px-3 py-2 text-destructive text-sm">{String(listing.error)}</p>
			)}

			<MenuShell items={paneMenu}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for the current folder */}
				<div
					className={cn("min-h-0 flex-1 overflow-y-auto", dropTarget === path && "bg-primary/10")}
					onDragOver={(ev) => allowDrop(ev, path)}
					onDragLeave={() => setDropTarget(null)}
					onDrop={(ev) => dropInto(ev, path)}
				>
					{creating && (
						<NameRow
							icon={<Folder className="size-4 text-primary" />}
							initial=""
							placeholder="New folder"
							onCancel={() => setCreating(false)}
							onSubmit={(name) =>
								makeDir.mutate(
									{ parent: path, name },
									{
										onError: fail,
										onSuccess: () => {
											setCreating(false);
											setSel({ selected: new Set([name]), anchor: name });
										},
									},
								)
							}
						/>
					)}
					{entries.map((e) =>
						renaming === e.name ? (
							<NameRow
								key={e.name}
								icon={<EntryIcon entry={e} />}
								initial={e.name}
								onCancel={() => setRenaming(null)}
								onSubmit={(newName) => submitRename(e, newName)}
							/>
						) : (
							<EntryRow
								key={e.name}
								entry={e}
								path={joinPath(path, e.name)}
								selected={selected.has(e.name)}
								active={active}
								dropping={dropTarget === joinPath(path, e.name)}
								onDragStart={(ev) => dragStart(ev, e)}
								onClick={(ev) => onRowClick(e, ev)}
								onOpen={() => open(e)}
								onDragOver={(ev) => allowDrop(ev, joinPath(path, e.name))}
								onDragLeave={() => setDropTarget(null)}
								onDrop={(ev) => dropInto(ev, joinPath(path, e.name))}
								menu={menuFor(e)}
								onContextMenu={() => selectForMenu(e)}
								dimmed={
									clipboard?.mode === "cut" && clipboard.paths.includes(joinPath(path, e.name))
								}
							/>
						),
					)}
					{listing.isSuccess && entries.length === 0 && !creating && (
						<p className="p-3 text-muted-foreground text-sm">Empty folder.</p>
					)}
				</div>
			</MenuShell>
			<div className="border-t px-3 py-1 text-muted-foreground text-xs">
				{entries.length} item{entries.length === 1 ? "" : "s"}
				{selected.size > 0 && ` · ${selected.size} selected`}
			</div>
		</section>
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
	| null;

const KEYS: Record<string, KeyAction> = {
	"mod+n": "newFolder",
	"mod+c": "copy",
	"mod+x": "cut",
	"mod+v": "paste",
	"mod+a": "all",
	"mod+backspace": "delete",
	delete: "delete",
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
	open: (e: FsEntry) => unknown;
	rename: (name: string) => unknown;
	newFolder: () => unknown;
	cut: (paths: string[]) => unknown;
	copy: (paths: string[]) => unknown;
	paste: (dest: string) => unknown;
	remove: (paths: string[]) => unknown;
	moveToOther: (paths: string[]) => unknown;
}

/** Right-click menu entries for `entry` (or for empty space when there is none). */
function buildMenu(
	ctx: { actions: PaneActionSet; hasClipboard: boolean; canMoveToOther: boolean },
	target: { entry?: FsEntry; paths: string[]; dest: string },
): MenuItem[] {
	const { actions: a } = ctx;
	const { entry, paths, dest } = target;
	const items: MenuItem[] = [];
	if (entry?.isDir) {
		items.push({ label: "Open", icon: FolderOpen, run: () => a.open(entry) });
	}
	if (entry) {
		items.push({ label: "Rename", icon: Pencil, shortcut: "F2", run: () => a.rename(entry.name) });
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
	items.push({ label: "New folder", icon: FolderPlus, shortcut: "⌘N", run: () => a.newFolder() });
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

function EntryRow({
	entry,
	path,
	selected,
	active,
	dropping,
	onDragStart,
	onClick,
	onOpen,
	onDragOver,
	onDragLeave,
	onDrop,
	menu,
	onContextMenu,
	dimmed,
}: {
	entry: FsEntry;
	path: string;
	selected: boolean;
	active: boolean;
	dropping: boolean;
	onDragStart: (ev: DragEvent) => void;
	onClick: (ev: MouseEvent) => void;
	onOpen: () => void;
	onDragOver: (ev: DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (ev: DragEvent) => void;
	menu: MenuItem[];
	onContextMenu: () => void;
	dimmed: boolean;
}) {
	const highlight = active ? "bg-primary/25" : "bg-muted";
	return (
		<MenuShell items={menu}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled at pane level */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: selectable, draggable row */}
			<div
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
				className={cn(
					"flex cursor-default select-none items-center gap-2 px-3 py-1 text-sm",
					selected ? highlight : "hover:bg-muted/60",
					dropping && "bg-primary/30 ring-1 ring-primary ring-inset",
					dimmed && "opacity-50",
				)}
			>
				<EntryIcon entry={entry} path={path} />
				<span className="min-w-0 flex-1 truncate">{entry.name}</span>
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
						{items.map(({ label, icon: Icon, run, shortcut, disabled, danger }) => (
							<ContextMenu.Item
								key={label}
								className={cn(menuItem, danger && "text-destructive")}
								disabled={disabled}
								onClick={run}
							>
								<Icon className="size-4" />
								<span className="flex-1">{label}</span>
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
	icon,
	initial,
	placeholder,
	onSubmit,
	onCancel,
}: {
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
			className="flex items-center gap-2 px-2 py-0.5"
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
