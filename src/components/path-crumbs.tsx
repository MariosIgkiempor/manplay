import { useQueries } from "@tanstack/react-query";
import { Popover, PopoverTrigger } from "@ui-sdk/react/popover";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import {
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { PopoverPopup } from "#/components/ui/popup.tsx";
import { pickRows } from "#/lib/folder-pick.ts";
import { joinPath } from "#/lib/fs-path.ts";
import type { useFileDrag } from "#/lib/use-file-drag.tsx";
import type { TreeSource } from "#/lib/use-tree.ts";
import { cn } from "#/lib/utils.ts";

type Drag = Pick<
	ReturnType<typeof useFileDrag>,
	"dropTarget" | "allowDrop" | "clearDrop" | "dropInto"
>;

/** Drop handlers that make an element a place to drop files into `to`. */
const dropProps = (drag: Drag, to: string) => ({
	onDragOver: (ev: DragEvent<HTMLElement>) => drag.allowDrop(ev, to),
	onDragLeave: drag.clearDrop,
	onDrop: (ev: DragEvent<HTMLElement>) => drag.dropInto(ev, to),
});

/**
 * What a crumb opens, like VS Code's breadcrumbs: the folders beside it, the current one marked,
 * as a tree you can open further. Typing filters; ↑↓ move, → opens a folder's subfolders, ← closes
 * them, Enter goes there.
 */
function FolderPicker({
	dir,
	current,
	source,
	onNavigate,
	onClose,
}: {
	dir: string;
	current: string;
	source: TreeSource;
	onNavigate: (path: string) => void;
	onClose: () => void;
}) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [filter, setFilter] = useState("");
	const [active, setActive] = useState(current);
	const dirs = [dir, ...expanded];
	// Same cache entries as the panes' own listings.
	const lists = useQueries({
		queries: dirs.map((d) => ({
			queryKey: [source.key, d],
			queryFn: () => source.list(d),
			retry: false,
		})),
	});
	const listed = new Map<string, string[]>();
	for (const [i, q] of lists.entries()) {
		const d = dirs[i];
		if (d !== undefined && q.data) {
			listed.set(
				d,
				q.data.filter((e) => e.isDir && !e.name.startsWith(".")).map((e) => e.name),
			);
		}
	}
	const rows = pickRows(dir, listed, expanded, filter);
	const at = Math.max(
		0,
		rows.findIndex((r) => r.path === active),
	);
	const toggle = (path: string, open: boolean) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			next[open ? "add" : "delete"](path);
			return next;
		});
	const go = (path: string) => {
		onNavigate(path);
		onClose();
	};
	const list = useRef<HTMLDivElement>(null);
	useEffect(() => {
		list.current
			?.querySelector(`[data-path="${CSS.escape(rows[at]?.path ?? "")}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [at, rows]);

	const step = (by: number) =>
		setActive(rows[Math.min(rows.length - 1, Math.max(0, at + by))]?.path ?? active);
	const onKeyDown = (ev: KeyboardEvent) => {
		const row = rows[at];
		const moves: Record<string, () => void> = {
			arrowdown: () => step(1),
			arrowup: () => step(-1),
			arrowright: () => row && toggle(row.path, true),
			arrowleft: () => row && toggle(row.path, false),
			enter: () => row && go(row.path),
		};
		const move = moves[ev.key.toLowerCase()];
		if (move) {
			ev.preventDefault();
			move();
		}
	};

	return (
		<div className="flex w-72 flex-col">
			<input
				// biome-ignore lint/a11y/noAutofocus: the picker opens to be typed into, like VS Code's
				autoFocus
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder="Filter folders"
				aria-label="Filter folders"
				spellCheck={false}
				className="h-8 border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/60"
			/>
			<div ref={list} role="listbox" aria-label="Folders" className="max-h-80 overflow-y-auto p-1">
				{lists[0]?.isPending && (
					<p className="px-2 py-1.5 text-muted-foreground text-sm">Loading…</p>
				)}
				{lists[0]?.isError && (
					<p className="px-2 py-1.5 text-destructive text-sm">{String(lists[0].error)}</p>
				)}
				{lists[0]?.isSuccess && rows.length === 0 && (
					<p className="px-2 py-1.5 text-muted-foreground text-sm">No folders</p>
				)}
				{rows.map((r, i) => (
					<div
						key={r.path}
						role="option"
						aria-selected={i === at}
						data-path={r.path}
						tabIndex={-1}
						className={cn(
							"flex h-7 cursor-default items-center gap-1 rounded-md pr-2 text-sm",
							i === at && "bg-muted",
							r.path === joinPath(dir, current) && "font-medium",
						)}
						style={{ paddingLeft: `${0.25 + r.depth}rem` }}
						onMouseMove={() => setActive(r.path)}
						onClick={() => go(r.path)}
						onKeyDown={onKeyDown}
					>
						<button
							type="button"
							tabIndex={-1}
							aria-label={r.open ? `Close ${r.name}` : `Open ${r.name}`}
							className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
							onClick={(ev) => {
								ev.stopPropagation();
								toggle(r.path, !r.open);
							}}
						>
							<ChevronRight
								className={cn("size-3.5 transition-transform", r.open && "rotate-90")}
							/>
						</button>
						{r.open ? (
							<FolderOpen className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<Folder className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 flex-1 truncate">{r.name}</span>
					</div>
				))}
			</div>
		</div>
	);
}

/** A folder crumb: goes nowhere on its own, opens the picker of its siblings, takes drops. */
function Crumb({
	name,
	dir,
	strong,
	source,
	drag,
	onNavigate,
}: {
	name: string;
	/** The folder holding this one. */
	dir: string;
	strong: boolean;
	source: TreeSource;
	drag: Drag;
	onNavigate: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const to = joinPath(dir, name);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				className={cn(
					"min-w-0 truncate rounded-md px-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 data-[open]:bg-muted",
					strong && "font-medium",
					drag.dropTarget === to && "bg-primary/20",
				)}
				{...dropProps(drag, to)}
			>
				{name}
			</PopoverTrigger>
			<PopoverPopup
				sideOffset={4}
				align="start"
				className="overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none"
			>
				<FolderPicker
					dir={dir}
					current={name}
					source={source}
					onNavigate={onNavigate}
					onClose={() => setOpen(false)}
				/>
			</PopoverPopup>
		</Popover>
	);
}

/**
 * Where a pane is, like VS Code's breadcrumbs: the source first (a menu of the library and
 * destinations), then each folder. Clicking a folder opens a picker of the folders beside it, as
 * a tree to look further. Every crumb is also a place to drop files.
 */
export function PathCrumbs({
	source,
	first,
	root,
	crumbs,
	drag,
	onNavigate,
}: {
	source: TreeSource;
	/** What is browsed, e.g. the source picker; dropping on it puts files in `root`. */
	first: ReactNode;
	root: string;
	crumbs: readonly string[];
	drag: Drag;
	onNavigate: (path: string) => void;
}) {
	return (
		<nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap text-sm">
			<span
				className={cn("shrink-0 rounded-md", drag.dropTarget === root && "bg-primary/20")}
				{...dropProps(drag, root)}
			>
				{first}
			</span>
			{crumbs.map((name, i) => {
				const dir = i === 0 ? root : joinPath(root, ...crumbs.slice(0, i));
				return (
					<span key={joinPath(dir, name)} className="flex min-w-0 items-center gap-0.5">
						<ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
						<Crumb
							name={name}
							dir={dir}
							strong={i === crumbs.length - 1}
							source={source}
							drag={drag}
							onNavigate={onNavigate}
						/>
					</span>
				);
			})}
		</nav>
	);
}
