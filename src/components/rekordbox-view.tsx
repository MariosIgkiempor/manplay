import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FileDown, FolderOpen, ListMusic, Tag as TagIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CheckList, CheckRow, Filter, LinkButton, TagTree } from "#/components/check-list.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
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
import { sameSelection } from "#/lib/rekordbox-selection.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { useAutosave } from "#/lib/unsaved.tsx";
import { useRekordbox } from "#/lib/use-rekordbox.ts";
import { cn } from "#/lib/utils.ts";

const EMPTY: RekordboxSelection = { excludedPlaylists: [], tags: [] };

function plural(n: number, one: string) {
	return `${n} ${n === 1 ? one : `${one}s`}`;
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
		<section className="space-y-3">
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
					<CheckList>
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
					</CheckList>
				</>
			)}
		</Group>
	);
}

function Tags({
	selection,
	onChange,
}: {
	selection: RekordboxSelection;
	onChange: (s: RekordboxSelection) => void;
}) {
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const all = tags.data ?? [];
	return (
		<Group
			title="Tags as playlists"
			count={`${selection.tags.length} selected`}
			actions={
				<>
					<LinkButton
						disabled={all.length === 0 || selection.tags.length >= all.length}
						onClick={() => onChange({ ...selection, tags: all.map((t) => t.name) })}
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
				<TagTree
					tags={all}
					selected={selection.tags}
					onChange={(names) => onChange({ ...selection, tags: names })}
				/>
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
	pending,
	onExport,
	onClose,
}: {
	count: number;
	/** The choice changed since the file was last written. */
	unexported: boolean;
	saveState: ReactNode;
	pending: boolean;
	onExport: () => void;
	onClose: () => void;
}) {
	let note = "";
	if (unexported) {
		note = ", changes not exported yet";
	}
	return (
		<div className="-mx-4 -mb-4 sticky bottom-0 z-10 flex items-center gap-3 border-t bg-background/85 px-4 py-3 backdrop-blur-md">
			<p className="min-w-0 flex-1 truncate text-muted-foreground text-sm tabular-nums">
				{plural(count, "playlist")} in the file{note}
			</p>
			{saveState}
			<Button variant="ghost" onClick={onClose} disabled={pending}>
				Cancel
			</Button>
			<Button onClick={onExport} disabled={pending}>
				{pending ? "Exporting…" : "Export"}
			</Button>
		</div>
	);
}

type Tab = "playlists" | "tags" | "file";

/** The file's name and what it holds, as the USB export drawer shows the drive and its space. */
function FileTitle({
	path,
	tracks,
	playlists,
	exportedAt,
}: {
	path: string | null;
	tracks: number | null;
	playlists: number | null;
	exportedAt: number | null;
}) {
	return (
		<div className="space-y-1">
			<h2 className={cn("truncate", typeScale.panelTitle)} title={path ?? undefined}>
				{path === null ? "rekordbox" : (path.split(/[\\/]/).pop() ?? path)}
			</h2>
			<p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs tabular-nums">
				{tracks !== null && <span>{plural(tracks, "track")} in the file</span>}
				{playlists !== null && <span>{plural(playlists, "playlist")}</span>}
				<span>{exportedAt === null ? "Never exported" : `Exported ${timeAgo(exportedAt)}`}</span>
			</p>
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
	return tab === "playlists" ? (
		<Playlists selection={selection} onChange={onChange} />
	) : (
		<Tags selection={selection} onChange={onChange} />
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
export function RekordboxExport({ onClose }: { onClose: () => void }) {
	const queryClient = useQueryClient();
	const { status, choose } = useRekordbox();
	const saved = useQuery({ queryKey: ["rekordbox-selection"], queryFn: rekordboxSelection });
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const library = useQuery({ queryKey: ["rekordbox-library"], queryFn: rekordboxLibrary });
	const [draft, setDraft] = useState<RekordboxSelection | null>(null);
	const [tab, setTab] = useState<Tab>("playlists");
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
	const playlistsOn = (playlists.data ?? []).filter(
		(p) => !selection.excludedPlaylists.includes(p.id),
	).length;
	const exported = playlistsOn + selection.tags.length;
	const exportedAt = status.data?.exportedAt ?? null;

	return (
		<div className="flex min-h-full flex-col gap-5">
			<FileTitle
				path={path}
				tracks={library.data?.tracks ?? null}
				playlists={library.data?.playlists.length ?? null}
				exportedAt={exportedAt}
			/>
			{status.isSuccess && path === null ? (
				<NoFile onChoose={() => choose.mutate()} pending={choose.isPending} />
			) : (
				<div className="flex-1 space-y-4">
					<Segmented
						value={tab}
						onChange={setTab}
						label="rekordbox export"
						items={[
							{
								value: "playlists",
								label: "Playlists",
								icon: <ListMusic />,
								count: playlistsOn,
							},
							{ value: "tags", label: "Tags", icon: <TagIcon />, count: selection.tags.length },
							{ value: "file", label: "In rekordbox", icon: <FileDown /> },
						]}
					/>
					<TabBody tab={tab} selection={selection} onChange={setDraft} />
				</div>
			)}
			<MutationErrors mutations={[exportNow, choose]} />
			{path !== null && (
				<ExportBar
					count={exported}
					unexported={unexported || autosave.dirty}
					saveState={<SaveState status={autosave.status} error={autosave.error} />}
					pending={exportNow.isPending}
					onExport={() => exportNow.mutate(selection)}
					onClose={onClose}
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
				{open && <RekordboxExport onClose={() => setOpen(false)} />}
			</Drawer>
		</>
	);
}
