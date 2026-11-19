import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Download, FolderOpen, Pause, Play } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { DROP_PANE, DropChip, DropHintBar } from "#/components/drop-feedback.tsx";
import {
	Banners,
	Chevron,
	ColumnHeader,
	EntryColumns,
	EntryIcon,
	INDENT,
	LocationBar,
	type MenuItem,
	MenuShell,
	Name,
	PaneFooter,
	type PlayState,
	rowTone,
	SongIcon,
} from "#/components/file-pane.tsx";
import { NoticeBar } from "#/components/notice-bar.tsx";
import { PathCrumbs } from "#/components/path-crumbs.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	type PullOutcome,
	remoteDirSizes,
	remoteList,
	remotePull,
	remoteTrackPath,
} from "#/lib/api.ts";
import type { PaneSource } from "#/lib/drag-session.ts";
import { isAudioName, parentPath, relSegments } from "#/lib/fs-path.ts";
import { applyClick, EMPTY_SELECTION, type Selection } from "#/lib/selection.ts";
import {
	DEFAULT_FILE_SORT,
	type FileSort,
	filterRows,
	nameMatches,
	type TreeRow,
} from "#/lib/tree.ts";
import { useFileDrag } from "#/lib/use-file-drag.tsx";
import { useFilePlay } from "#/lib/use-file-play.ts";
import { useTree } from "#/lib/use-tree.ts";
import { cn } from "#/lib/utils.ts";

/** Remote folders are addressed as `/a/b` inside the destination, so `/` is its folder. */
const ROOT = "/";

function rowMenu({
	row,
	chosen,
	playing,
	pulling,
	onOpen,
	onPlay,
	onPull,
}: {
	row: TreeRow;
	chosen: readonly TreeRow[];
	playing: boolean;
	pulling: boolean;
	onOpen: () => void;
	onPlay: () => void;
	onPull: (rows: readonly TreeRow[]) => void;
}): MenuItem[] {
	const items: MenuItem[] = [];
	if (row.entry.isDir) {
		items.push({ label: "Open", icon: FolderOpen, run: onOpen });
	} else if (isAudioName(row.entry.name)) {
		items.push({ label: playing ? "Pause" : "Play", icon: playing ? Pause : Play, run: onPlay });
	}
	items.push({
		label: chosen.length > 1 ? `Pull ${chosen.length} items to library` : "Pull to library",
		icon: Download,
		run: () => onPull(chosen),
		disabled: pulling,
	});
	return items;
}

type Drag = ReturnType<typeof useFileDrag>;

/** One file or folder: select, open, play, drag, and take a drop when it is a folder. */
function RemoteRow({
	row,
	query,
	selected,
	expanded,
	loading,
	playState,
	menu,
	drag,
	onClick,
	onContextMenu,
	onOpen,
	onToggle,
	onPlay,
}: {
	row: TreeRow;
	query: string;
	selected: boolean;
	expanded: boolean;
	loading: boolean;
	playState: PlayState;
	menu: MenuItem[];
	drag: Drag;
	onClick: (ev: MouseEvent) => void;
	onContextMenu: () => void;
	onOpen: () => void;
	onToggle: () => void;
	onPlay: () => void;
}) {
	const { entry, path, depth } = row;
	const dropping = drag.dropTarget === path;
	const song = !entry.isDir && isAudioName(entry.name);
	return (
		<MenuShell items={menu}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: read-only list, folders open on double-click */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: selectable, draggable row */}
			<div
				draggable
				onDragStart={(ev) => drag.dragStart(ev, path)}
				onDragEnd={drag.dragEnd}
				onDragOver={entry.isDir ? (ev) => drag.allowDrop(ev, path) : undefined}
				onDragLeave={drag.clearDrop}
				onDrop={entry.isDir ? (ev) => drag.dropInto(ev, path) : undefined}
				onContextMenu={(ev) => {
					ev.stopPropagation();
					onContextMenu();
				}}
				onClick={onClick}
				onDoubleClick={onOpen}
				style={{ paddingLeft: `${12 + depth * INDENT}px` }}
				className={cn(
					"group/row mx-1 flex cursor-default select-none items-center gap-2 rounded-md py-1 pr-2 text-sm",
					rowTone({
						selected,
						active: true,
						dropping,
						faded: drag.carried.has(path),
					}),
				)}
			>
				<Chevron entry={entry} open={expanded} loading={loading} onToggle={onToggle} />
				{song ? (
					<SongIcon entry={entry} path={path} state={playState} onPlay={onPlay} />
				) : (
					<EntryIcon entry={entry} />
				)}
				<span
					className={cn("min-w-0 flex-1 truncate", playState && "font-medium text-primary")}
					title={entry.name}
				>
					<Name name={entry.name} query={query} />
				</span>
				{dropping && drag.dropOp && <DropChip op={drag.dropOp} />}
				<EntryColumns entry={entry} />
			</div>
		</MenuShell>
	);
}

function describePull(o: PullOutcome): string {
	const parts = [`Pulled ${o.pulled}`];
	if (o.skipped > 0) {
		parts.push(`${o.skipped} already in the library`);
	}
	if (o.failedTotal > 0) {
		parts.push(`${o.failedTotal} failed: ${o.failed.slice(0, 3).join(", ")}`);
	}
	return parts.join(" · ");
}

/**
 * Browser for a destination (WebDAV or R2): play songs, pull files into the library, and drag
 * files to and from the library or between its folders.
 */
export function RemotePane({
	pane,
	targetId,
	label,
	sourcePicker,
	onActivate,
}: {
	pane: 0 | 1;
	targetId: number;
	label: string;
	/** The first crumb, what this pane shows, given a way back to the top folder. */
	sourcePicker: (goTop: () => void) => ReactNode;
	onActivate: () => void;
}) {
	const [path, setPath] = useState(ROOT);
	const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT);
	const [query, setQuery] = useState("");
	const [sel, setSel] = useState<Selection<string>>(EMPTY_SELECTION);
	const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
	const queryClient = useQueryClient();
	const filterRef = useRef<HTMLInputElement>(null);
	const source = useMemo(
		() => ({
			key: `remote-${targetId}`,
			list: (dir: string) => remoteList(targetId, relSegments(ROOT, dir)),
			sizes: (dir: string) => remoteDirSizes(targetId, relSegments(ROOT, dir)),
		}),
		[targetId],
	);
	const { listing, entries, rows, expanded, isLoading, setOpen } = useTree(path, sort, source);
	const shown = filterRows(rows, query);
	const player = useFilePlay((p) => remoteTrackPath(targetId, relSegments(ROOT, p)));
	const playStateOf = (p: string): PlayState => {
		const here = remoteTrackPath(targetId, relSegments(ROOT, p));
		return player.current !== here ? null : player.playing ? "playing" : "paused";
	};
	const crumbs = relSegments(ROOT, path);
	const paneSource = useMemo<PaneSource>(() => ({ kind: "remote", id: targetId }), [targetId]);
	const drag = useFileDrag({
		pane,
		source: paneSource,
		describe: (p) => {
			const r = shown.find((row) => row.path === p);
			return r && { path: p, name: r.entry.name, isDir: r.entry.isDir };
		},
		selected: sel.selected,
		selectOnly: (p) => setSel({ selected: new Set([p]), anchor: p }),
		spring: {
			isClosedFolder: (p) => shown.some((r) => r.path === p && r.entry.isDir) && !expanded.has(p),
			open: (p) => setOpen(p, true),
		},
	});
	const filtering = query.trim() !== "";

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the folder or remote changes
	useEffect(() => {
		setSel(EMPTY_SELECTION);
		setQuery("");
		setNotice(null);
	}, [path, targetId]);
	// A different remote starts at its top folder.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the remote changes
	useEffect(() => setPath(ROOT), [targetId]);

	const play = (p: string) => {
		const row = shown.find((r) => r.path === p);
		if (row && !row.entry.isDir && isAudioName(row.entry.name)) {
			player.toggle(shown, p);
		}
	};
	const visible = shown.map((r) => r.path);
	const picked = shown.filter((r) => sel.selected.has(r.path));
	const pickedFiles = picked.filter((r) => !r.entry.isDir);
	const pull = useMutation({
		mutationFn: (chosen: readonly TreeRow[]) =>
			remotePull(
				targetId,
				chosen.map((r) => relSegments(ROOT, r.path)),
			),
		onSuccess: async (o) => {
			setNotice({ text: describePull(o), failed: o.failedTotal > 0 });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			await queryClient.invalidateQueries({ queryKey: ["fs"] });
		},
		onError: (e) => setNotice({ text: String(e), failed: true }),
	});
	const startPull = (chosen: readonly TreeRow[]) => {
		setNotice(null);
		pull.mutate(chosen);
	};
	/** The right-click menu acts on the whole selection when the row is part of it. */
	const menuFor = (r: TreeRow) =>
		rowMenu({
			row: r,
			chosen: sel.selected.has(r.path) ? picked : [r],
			playing: playStateOf(r.path) === "playing",
			pulling: pull.isPending,
			onOpen: () => setPath(r.path),
			onPlay: () => play(r.path),
			onPull: startPull,
		});

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a click anywhere in the pane makes it the active one
		<section
			onMouseDown={onActivate}
			className="@container/pane relative flex h-full min-h-0 min-w-0 flex-1 flex-col border-r bg-card/40 outline-none last:border-r-0"
		>
			<div className="flex items-center gap-1 border-b px-3 py-2 @3xl/pane:px-6">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Up one folder"
					title="Up one folder"
					disabled={path === ROOT}
					onClick={() => setPath(parentPath(path))}
				>
					<ArrowUp />
				</Button>
				<LocationBar
					inputRef={filterRef}
					value={query}
					matches={filtering ? shown.filter((r) => nameMatches(r.entry.name, query)).length : 0}
					onChange={setQuery}
					onDone={(keep) => !keep && setQuery("")}
				>
					<PathCrumbs
						source={source}
						first={sourcePicker(() => setPath(ROOT))}
						root={ROOT}
						crumbs={crumbs}
						drag={drag}
						onNavigate={setPath}
					/>
				</LocationBar>
				<Button
					variant="outline"
					size="sm"
					disabled={picked.length === 0 || pull.isPending}
					title="Download the selected files and folders into the library"
					onClick={() => startPull(picked)}
				>
					<Download />
					{pull.isPending ? "Pulling…" : "Pull to library"}
				</Button>
			</div>
			<NoticeBar notice={notice} />
			<Banners error={null} listError={listing?.isError ? String(listing.error) : null} />
			<ColumnHeader sort={sort} onSort={setSort} />
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for the current folder */}
			<div
				data-pane-list
				className={cn(
					"min-h-0 flex-1 overflow-y-auto py-0.5",
					drag.dropTarget === path && DROP_PANE,
				)}
				onDragOver={(ev) => drag.allowDrop(ev, path)}
				onDragLeave={drag.clearDrop}
				onDrop={(ev) => drag.dropInto(ev, path)}
			>
				{listing?.isPending && <p className="px-3 py-2 text-muted-foreground text-sm">Loading…</p>}
				{shown.map((r) => (
					<RemoteRow
						key={r.path}
						row={r}
						query={query}
						selected={sel.selected.has(r.path)}
						expanded={expanded.has(r.path)}
						loading={expanded.has(r.path) && isLoading(r.path)}
						playState={playStateOf(r.path)}
						menu={menuFor(r)}
						drag={drag}
						onClick={(ev) =>
							setSel((prev) =>
								applyClick(prev, visible, r.path, {
									shift: ev.shiftKey,
									toggle: ev.metaKey || ev.ctrlKey,
								}),
							)
						}
						onContextMenu={() =>
							setSel((prev) =>
								prev.selected.has(r.path) ? prev : { selected: new Set([r.path]), anchor: r.path },
							)
						}
						onOpen={() => (r.entry.isDir ? setPath(r.path) : play(r.path))}
						onToggle={() => setOpen(r.path, !expanded.has(r.path))}
						onPlay={() => play(r.path)}
					/>
				))}
				{listing?.isSuccess && entries.length === 0 && (
					<p className="px-6 py-12 text-center text-muted-foreground text-sm">
						This folder is empty
					</p>
				)}
			</div>
			<PaneFooter
				count={shown.length}
				matches={filtering ? shown.length : null}
				selected={picked.length}
				bytes={pickedFiles.reduce((n, r) => n + r.entry.size, 0)}
			/>
			<DropHintBar
				hint={drag.hintFor((p) => (p === ROOT ? label : (relSegments(ROOT, p).pop() ?? label)))}
			/>
		</section>
	);
}
