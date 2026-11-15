import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FileDown, FolderOpen, ListMusic, Search, Tag } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { BrandIcon } from "#/components/brand-icon.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	listPlaylists,
	listTags,
	type RekordboxLibrary,
	type RekordboxSelection,
	rekordboxLibrary,
	rekordboxSelection,
	saveRekordboxSelection,
	setRekordboxSelection,
} from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { sameSelection, setTagTree, type TagCheck, tagCheck } from "#/lib/rekordbox-selection.ts";
import { buildTagTree, type TagNode } from "#/lib/tag-tree.ts";
import { useAutosave } from "#/lib/unsaved.tsx";
import { useRekordbox } from "#/lib/use-rekordbox.ts";
import { cn } from "#/lib/utils.ts";

const EMPTY: RekordboxSelection = { excludedPlaylists: [], tags: [] };

function plural(n: number, one: string) {
	return `${n} ${n === 1 ? one : `${one}s`}`;
}

function CheckRow({
	state,
	onChange,
	label,
	detail,
	indent = 0,
	lead,
	icon,
}: {
	state: TagCheck;
	onChange: (on: boolean) => void;
	label: string;
	detail: string;
	indent?: number;
	lead?: ReactNode;
	icon: ReactNode;
}) {
	const box = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (box.current) {
			box.current.indeterminate = state === "some";
		}
	}, [state]);
	return (
		<div
			className={cn(
				"flex items-center gap-1 rounded-lg pr-2 transition-colors hover:bg-muted/60",
				state === "on" && "bg-primary/5",
			)}
			style={{ paddingLeft: `${4 + indent * 16}px` }}
		>
			<span className="flex size-6 shrink-0 items-center justify-center">{lead}</span>
			<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-sm">
				<input
					ref={box}
					type="checkbox"
					checked={state === "on"}
					onChange={(e) => onChange(e.target.checked)}
					className="size-4 accent-primary"
				/>
				<span className="shrink-0 text-muted-foreground">{icon}</span>
				<span className={cn("min-w-0 flex-1 truncate", state === "off" && "text-muted-foreground")}>
					{label}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">{detail}</span>
			</label>
		</div>
	);
}

function Group({
	title,
	count,
	hint,
	actions,
	children,
}: {
	title: string;
	count?: string | undefined;
	hint?: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="space-y-3 rounded-lg border bg-card p-4">
			<div className="space-y-1">
				<div className="flex items-center justify-between gap-2">
					<h2 className="flex items-baseline gap-2 font-semibold text-sm">
						{title}
						{count && (
							<span className="font-normal text-muted-foreground tabular-nums">{count}</span>
						)}
					</h2>
					{actions && <div className="flex gap-3 text-xs">{actions}</div>}
				</div>
				{hint && <p className="text-muted-foreground text-xs">{hint}</p>}
			</div>
			{children}
		</section>
	);
}

function LinkButton({
	children,
	onClick,
	disabled,
}: {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
		>
			{children}
		</button>
	);
}

function Filter({
	value,
	onChange,
	label,
}: {
	value: string;
	onChange: (v: string) => void;
	label: string;
}) {
	return (
		<div className="relative">
			<Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={label}
				aria-label={label}
				className="pl-8"
			/>
		</div>
	);
}

const LIST = "max-h-72 space-y-0.5 overflow-y-auto rounded-lg border bg-background p-1";

function Playlists({
	selection,
	onChange,
}: {
	selection: RekordboxSelection;
	onChange: (s: RekordboxSelection) => void;
}) {
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const [filter, setFilter] = useState("");
	const all = playlists.data ?? [];
	const shown = all.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
	const on = all.filter((p) => !selection.excludedPlaylists.includes(p.id)).length;
	const toggle = (id: number, include: boolean) =>
		onChange({
			...selection,
			excludedPlaylists: include
				? selection.excludedPlaylists.filter((x) => x !== id)
				: [...selection.excludedPlaylists, id],
		});
	return (
		<Group
			title="Playlists"
			count={`${on} of ${all.length}`}
			actions={
				<>
					<LinkButton
						disabled={on === all.length}
						onClick={() => onChange({ ...selection, excludedPlaylists: [] })}
					>
						Select all
					</LinkButton>
					<LinkButton
						disabled={on === 0}
						onClick={() => onChange({ ...selection, excludedPlaylists: all.map((p) => p.id) })}
					>
						Clear
					</LinkButton>
				</>
			}
		>
			{all.length === 0 ? (
				<p className="text-muted-foreground text-sm">No playlists yet.</p>
			) : (
				<>
					{all.length > 8 && (
						<Filter value={filter} onChange={setFilter} label="Filter playlists" />
					)}
					<div className={LIST}>
						{shown.map((p) => (
							<CheckRow
								key={p.id}
								label={p.name}
								detail={plural(p.trackCount, "track")}
								icon={<ListMusic className="size-4" />}
								state={selection.excludedPlaylists.includes(p.id) ? "off" : "on"}
								onChange={(include) => toggle(p.id, include)}
							/>
						))}
						{shown.length === 0 && (
							<p className="px-3 py-2 text-muted-foreground text-sm">No playlist matches.</p>
						)}
					</div>
				</>
			)}
		</Group>
	);
}

function TagRows({
	nodes,
	depth,
	selection,
	open,
	toggleOpen,
	onChange,
	flat,
}: {
	nodes: TagNode[];
	depth: number;
	selection: readonly string[];
	open: ReadonlySet<string>;
	toggleOpen: (key: string) => void;
	onChange: (node: TagNode, on: boolean) => void;
	flat: boolean;
}) {
	return nodes.map((n) => {
		const key = n.name.toLowerCase();
		const expanded = flat || open.has(key);
		const hasKids = n.children.length > 0 && !flat;
		return (
			<div key={key}>
				<CheckRow
					indent={flat ? 0 : depth}
					label={flat ? n.name : n.label}
					detail={plural(n.trackCount, "track")}
					icon={<Tag className="size-4" />}
					state={tagCheck(selection, n)}
					onChange={(on) => onChange(n, on)}
					lead={
						hasKids && (
							<button
								type="button"
								aria-label={`${open.has(key) ? "Collapse" : "Expand"} ${n.label}`}
								aria-expanded={open.has(key)}
								onClick={() => toggleOpen(key)}
								className="rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								<ChevronRight
									className={cn("size-4 transition-transform", open.has(key) && "rotate-90")}
								/>
							</button>
						)
					}
				/>
				{hasKids && expanded && (
					<TagRows
						nodes={n.children}
						depth={depth + 1}
						selection={selection}
						open={open}
						toggleOpen={toggleOpen}
						onChange={onChange}
						flat={flat}
					/>
				)}
			</div>
		);
	});
}

function Tags({
	selection,
	onChange,
}: {
	selection: RekordboxSelection;
	onChange: (s: RekordboxSelection) => void;
}) {
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const [filter, setFilter] = useState("");
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const all = tags.data ?? [];
	const tree = useMemo(() => buildTagTree(all), [all]);
	const needle = filter.trim().toLowerCase();
	// While filtering, matching tags show as a flat list so a deep match is never hidden.
	const matches = useMemo(
		() =>
			needle
				? tree
						.flatMap(function walk(n): TagNode[] {
							return [n, ...n.children.flatMap(walk)];
						})
						.filter((n) => n.name.toLowerCase().includes(needle))
				: [],
		[tree, needle],
	);
	const toggleOpen = (key: string) =>
		setOpen((s) => {
			const next = new Set(s);
			if (!next.delete(key)) {
				next.add(key);
			}
			return next;
		});
	const set = (node: TagNode, on: boolean) =>
		onChange({ ...selection, tags: setTagTree(selection.tags, node, on) });
	const allNames = tree.length === 0 ? [] : all.map((t) => t.name);
	return (
		<Group
			title="Tags as playlists"
			count={`${selection.tags.length} selected`}
			actions={
				<>
					<LinkButton
						disabled={selection.tags.length >= allNames.length}
						onClick={() => onChange({ ...selection, tags: allNames })}
					>
						Select all
					</LinkButton>
					<LinkButton
						disabled={selection.tags.length === 0}
						onClick={() => onChange({ ...selection, tags: [] })}
					>
						Clear
					</LinkButton>
				</>
			}
		>
			{all.length === 0 ? (
				<p className="text-muted-foreground text-sm">No tags yet.</p>
			) : (
				<>
					{all.length > 8 && <Filter value={filter} onChange={setFilter} label="Filter tags" />}
					<div className={LIST}>
						<TagRows
							nodes={needle ? matches : tree}
							depth={0}
							selection={selection.tags}
							open={open}
							toggleOpen={toggleOpen}
							onChange={set}
							flat={needle !== ""}
						/>
						{needle && matches.length === 0 && (
							<p className="px-3 py-2 text-muted-foreground text-sm">No tag matches.</p>
						)}
					</div>
				</>
			)}
		</Group>
	);
}

function Contents({ library }: { library: RekordboxLibrary }) {
	const groups = new Map<string, RekordboxLibrary["playlists"]>();
	for (const p of library.playlists) {
		const key = p.folders.join(" › ") || "Top level";
		groups.set(key, [...(groups.get(key) ?? []), p]);
	}
	if (groups.size === 0) {
		return <p className="text-muted-foreground text-sm">The file has no playlists.</p>;
	}
	return (
		<div className="space-y-4">
			{[...groups].map(([folder, lists]) => (
				<div key={folder} className="space-y-1">
					<p className="px-1 text-muted-foreground text-xs">{folder}</p>
					<div className="rounded-lg border">
						{lists.map((p) => (
							<details key={p.name} className="group border-b last:border-b-0">
								<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
									<ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
									<span className="min-w-0 flex-1 truncate">{p.name}</span>
									<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
										{plural(p.tracks.length, "track")}
									</span>
								</summary>
								<ol className="max-h-64 space-y-0.5 overflow-y-auto pr-3 pb-3 pl-9 text-muted-foreground text-xs">
									{p.tracks.length === 0 && <li>Empty</li>}
									{p.tracks.map((t, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: a song can repeat in a playlist
										<li key={i} className="truncate">
											{t.artist ? `${t.artist} – ${t.title}` : t.title}
										</li>
									))}
								</ol>
							</details>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

function InFile() {
	const library = useQuery({ queryKey: ["rekordbox-library"], queryFn: rekordboxLibrary });
	const data = library.data;
	return (
		<Group
			title="Already in the rekordbox file"
			count={
				data
					? `${plural(data.tracks, "track")} · ${plural(data.playlists.length, "playlist")}`
					: undefined
			}
		>
			{library.isError && <p className="text-destructive text-sm">{String(library.error)}</p>}
			{library.isPending && <p className="text-muted-foreground text-sm">Reading the file…</p>}
			{data === null && <p className="text-muted-foreground text-sm">Not exported yet.</p>}
			{data && <Contents library={data} />}
		</Group>
	);
}

function ExportBar({
	count,
	unexported,
	saveState,
	exportedAt,
	pending,
	onExport,
}: {
	count: number;
	/** The choice changed since the file was last written. */
	unexported: boolean;
	saveState: ReactNode;
	exportedAt: number | null;
	pending: boolean;
	onExport: () => void;
}) {
	let note = "";
	if (unexported) {
		note = " · changes not exported yet";
	} else if (exportedAt !== null) {
		note = ` · exported ${timeAgo(exportedAt)}`;
	}
	return (
		<div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-6 flex flex-wrap items-center gap-3 border-t bg-background/85 px-4 py-3 backdrop-blur-md">
			<p className="min-w-0 flex-1 text-muted-foreground text-sm">
				<span className="text-foreground">{plural(count, "playlist")}</span> will be in the file
				{note}
			</p>
			{saveState}
			<Button onClick={onExport} disabled={pending}>
				<FileDown /> {pending ? "Exporting…" : "Export to rekordbox"}
			</Button>
		</div>
	);
}

type Tab = "choose" | "file";

function Tabs({
	tab,
	onChange,
	fileCount,
}: {
	tab: Tab;
	onChange: (t: Tab) => void;
	fileCount: number | null;
}) {
	const items: [Tab, string][] = [
		["choose", "What to export"],
		["file", fileCount === null ? "In rekordbox" : `In rekordbox · ${fileCount}`],
	];
	return (
		<div role="tablist" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
			{items.map(([id, label]) => (
				<button
					key={id}
					type="button"
					role="tab"
					aria-selected={tab === id}
					onClick={() => onChange(id)}
					className={cn(
						"rounded-md px-3 py-1.5 font-medium text-sm transition-colors",
						tab === id
							? "bg-background text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{label}
				</button>
			))}
		</div>
	);
}

function Figure({ value, label }: { value: string | number; label: string }) {
	return (
		<div className="min-w-0 rounded-lg bg-background/70 px-3 py-2 ring-1 ring-foreground/5">
			<p className="truncate font-semibold text-xl tabular-nums leading-tight">{value}</p>
			<p className="truncate text-muted-foreground text-xs">{label}</p>
		</div>
	);
}

function Hero({
	path,
	tracks,
	exported,
	exportedAt,
}: {
	path: string | null;
	tracks: number | null;
	exported: number;
	exportedAt: number | null;
}) {
	return (
		<div className="space-y-3 rounded-lg border bg-muted/40 p-4">
			<div className="flex items-center gap-3">
				<BrandIcon brand="rekordbox" className="size-11" />
				<div className="min-w-0">
					<h2 className="font-semibold text-xl tracking-tight">Export to rekordbox</h2>
					{path && (
						<p className="truncate font-mono text-muted-foreground text-xs" title={path}>
							{path}
						</p>
					)}
				</div>
			</div>
			<div className="grid grid-cols-3 gap-2">
				<Figure value={tracks ?? "–"} label="tracks in file" />
				<Figure value={exported} label="playlists chosen" />
				<Figure value={exportedAt === null ? "Never" : timeAgo(exportedAt)} label="last export" />
			</div>
		</div>
	);
}

function TabBody({
	tab,
	selection,
	onChange,
}: {
	tab: Tab;
	selection: RekordboxSelection;
	onChange: (s: RekordboxSelection) => void;
}) {
	if (tab === "file") {
		return <InFile />;
	}
	return (
		<div className="space-y-4">
			<Playlists selection={selection} onChange={onChange} />
			<Tags selection={selection} onChange={onChange} />
		</div>
	);
}

function NoFile({ onChoose, pending }: { onChoose: () => void; pending: boolean }) {
	return (
		<div className="space-y-3 rounded-lg border border-dashed p-5 text-center">
			<p className="text-sm">Choose where manplay should save the rekordbox file.</p>
			<Button onClick={onChoose} disabled={pending}>
				<FolderOpen /> Choose location…
			</Button>
		</div>
	);
}

/** Choose what goes into the rekordbox file, see what is in it now, and write it. */
export function RekordboxExport() {
	const queryClient = useQueryClient();
	const { status, choose } = useRekordbox();
	const saved = useQuery({ queryKey: ["rekordbox-selection"], queryFn: rekordboxSelection });
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const library = useQuery({ queryKey: ["rekordbox-library"], queryFn: rekordboxLibrary });
	const [draft, setDraft] = useState<RekordboxSelection | null>(null);
	const [tab, setTab] = useState<Tab>("choose");
	const selection = draft ?? saved.data ?? EMPTY;
	// The choice saves on its own; the file is only written by the Export button.
	const [unexported, setUnexported] = useState(false);
	const autosave = useAutosave({
		label: "What goes into the rekordbox file",
		value: selection,
		saved: saved.data ?? selection,
		equal: sameSelection,
		save: async (v) => {
			const next = await saveRekordboxSelection(v);
			queryClient.setQueryData(["rekordbox-selection"], next);
			setUnexported(true);
		},
	});

	const exportNow = useMutation({
		mutationFn: setRekordboxSelection,
		onSuccess: (next) => {
			queryClient.setQueryData(["rekordbox-selection"], next);
			setDraft(null);
			setUnexported(false);
			for (const key of [["rekordbox"], ["rekordbox-library"], ["activity", "rekordbox"]]) {
				void queryClient.invalidateQueries({ queryKey: key });
			}
			setTab("file");
		},
	});

	const path = status.data?.path ?? null;
	const exported =
		(playlists.data ?? []).filter((p) => !selection.excludedPlaylists.includes(p.id)).length +
		selection.tags.length;
	const exportedAt = status.data?.exportedAt ?? null;

	return (
		<div className="space-y-4">
			<Hero
				path={path}
				tracks={library.data?.tracks ?? null}
				exported={exported}
				exportedAt={exportedAt}
			/>
			{status.isSuccess && path === null ? (
				<NoFile onChoose={() => choose.mutate()} pending={choose.isPending} />
			) : (
				<>
					<Tabs
						tab={tab}
						onChange={setTab}
						fileCount={library.data ? library.data.playlists.length : null}
					/>
					<TabBody tab={tab} selection={selection} onChange={setDraft} />
				</>
			)}
			<MutationErrors mutations={[exportNow, choose]} />
			{path !== null && (
				<ExportBar
					count={exported}
					unexported={unexported || autosave.dirty}
					saveState={<SaveState status={autosave.status} error={autosave.error} />}
					exportedAt={exportedAt}
					pending={exportNow.isPending}
					onExport={() => exportNow.mutate(selection)}
				/>
			)}
		</div>
	);
}

/** Button that opens the export drawer; nothing is written until the drawer's own button is used. */
export function RekordboxExportButton({
	size,
	variant,
	label = "Export…",
}: {
	size?: "sm" | "default";
	variant?: "default" | "outline";
	label?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button size={size} variant={variant} onClick={() => setOpen(true)}>
				<FileDown /> {label}
			</Button>
			<Drawer
				open={open}
				onClose={() => setOpen(false)}
				title="Export to rekordbox"
				width="w-[44rem]"
			>
				{open && <RekordboxExport />}
			</Drawer>
		</>
	);
}
