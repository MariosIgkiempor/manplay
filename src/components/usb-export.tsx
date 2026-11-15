import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, HardDriveUpload, ListMusic, Tag as TagIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { CheckList, CheckRow, Filter, LinkButton, TagTree } from "#/components/check-list.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import {
	exportToUsb,
	listPlaylists,
	listTags,
	onUsbExportProgress,
	type Playlist,
	playlistTracks,
	type Tag,
	type Track,
	type UsbDrive,
	type UsbExportProgress,
	type UsbExportReport,
	type UsbLibrary,
} from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { useTracks } from "#/lib/queries.ts";
import { TAG_SEP, trackHasTag } from "#/lib/tag-tree.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The playlist name a tag gets on the drive, as in the rekordbox XML export. */
const tagPlaylistName = (tag: string) => tag.split(TAG_SEP).join(" › ");

/** Room the export keeps free for the databases and analysis files (as the backend does). */
const HEADROOM = 16 * 1024 * 1024;

function useExportProgress(running: boolean): UsbExportProgress | null {
	const [progress, setProgress] = useState<UsbExportProgress | null>(null);
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void onUsbExportProgress(setProgress).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);
	useEffect(() => {
		if (!running) {
			setProgress(null);
		}
	}, [running]);
	return progress;
}

interface Estimate {
	songs: number;
	/** Songs with no file of the same size on the drive. */
	toCopy: number;
	bytes: number;
	/** Still waiting on a chosen playlist's songs. */
	loading: boolean;
}

/** Size of every chosen song by id: the playlists' songs, then songs carrying a chosen tag. */
function chosenSongs(
	fromPlaylists: readonly Track[],
	library: readonly Track[],
	tags: readonly string[],
): Map<number, number> {
	const songs = new Map(fromPlaylists.map((t) => [t.id, t.size]));
	for (const t of library) {
		if (tags.some((name) => trackHasTag(t, name))) {
			songs.set(t.id, t.size);
		}
	}
	return songs;
}

/**
 * What the chosen playlists and tags add up to. Songs count as already on the drive when it holds
 * a file of exactly the same size, which is how the export itself recognises them.
 */
function useEstimate(
	playlistIds: readonly number[],
	tags: readonly string[],
	library: UsbLibrary | undefined,
): Estimate {
	const tracks = useTracks();
	const lists = useQueries({
		queries: playlistIds.map((id) => ({
			queryKey: ["playlist-tracks", id],
			queryFn: () => playlistTracks(id),
		})),
	});
	const sizes = useMemo(() => new Set((library?.tracks ?? []).map((t) => t.fileSize)), [library]);
	const songs = chosenSongs(
		lists.flatMap((q) => q.data ?? []),
		tags.length > 0 ? (tracks.data ?? []) : [],
		tags,
	);
	const fresh = [...songs.values()].filter((size) => !sizes.has(size));
	const bytes = fresh.reduce((n, size) => n + size, 0);
	const toCopy = fresh.length;
	return {
		songs: songs.size,
		toCopy,
		bytes,
		loading: lists.some((q) => q.isPending) || (tags.length > 0 && tracks.isPending),
	};
}

/**
 * The drive as a bar: what is on it, what this export copies, and what is left. The one bold
 * element of the drawer, since space is what runs out on a stick.
 */
function SpaceMeter({ drive, adding }: { drive: UsbDrive; adding: number }) {
	const total = Math.max(drive.totalBytes, 1);
	const used = drive.totalBytes - drive.freeBytes;
	const fits = adding + HEADROOM <= drive.freeBytes;
	const left = Math.max(drive.freeBytes - adding, 0);
	const pct = (n: number) => `${Math.min(100, (n / total) * 100)}%`;
	return (
		<div className="space-y-2">
			<div
				aria-hidden="true"
				className="flex h-3 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/5"
			>
				<div className="h-full bg-muted-foreground/45" style={{ width: pct(used) }} />
				<div
					className={cn(
						"h-full transition-[width] duration-300 motion-reduce:transition-none",
						fits ? "bg-primary" : "bg-destructive",
					)}
					style={{ width: pct(Math.min(adding, drive.freeBytes)) }}
				/>
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs tabular-nums">
				<Swatch className="bg-muted-foreground/45">{formatBytes(used)} on the drive</Swatch>
				{adding > 0 && (
					<Swatch className={fits ? "bg-primary" : "bg-destructive"}>
						{formatBytes(adding)} to copy
					</Swatch>
				)}
				<span className={cn("ml-auto", !fits && "text-destructive")}>
					{fits ? `${formatBytes(left)} left` : "Doesn't fit"}
				</span>
			</div>
		</div>
	);
}

function Swatch({ className, children }: { className: string; children: ReactNode }) {
	return (
		<span className="flex items-center gap-1.5">
			<span aria-hidden="true" className={cn("size-2 rounded-full", className)} />
			{children}
		</span>
	);
}

type Tab = "playlists" | "tags";

function PickerHeader({
	hint,
	allOn,
	noneOn,
	onAll,
	onClear,
}: {
	hint: string;
	allOn: boolean;
	noneOn: boolean;
	onAll: () => void;
	onClear: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 text-xs">
			<p className="text-muted-foreground">{hint}</p>
			<div className="flex shrink-0 gap-3">
				<LinkButton disabled={allOn} onClick={onAll}>
					Select all
				</LinkButton>
				<LinkButton disabled={noneOn} onClick={onClear}>
					Clear
				</LinkButton>
			</div>
		</div>
	);
}

function PlaylistPicker({
	list,
	chosen,
	onDrive,
	onChange,
}: {
	list: readonly Playlist[];
	chosen: ReadonlySet<number>;
	/** Names of the drive's top-level playlists, which an export of the same name replaces. */
	onDrive: ReadonlySet<string>;
	onChange: (next: ReadonlySet<number>) => void;
}) {
	const [filter, setFilter] = useState("");
	if (list.length === 0) {
		return (
			<p className="py-6 text-center text-muted-foreground text-sm">No playlists with songs yet.</p>
		);
	}
	const needle = filter.trim().toLowerCase();
	const shown = list.filter((p) => p.name.toLowerCase().includes(needle));
	const toggle = (id: number, on: boolean) => {
		const next = new Set(chosen);
		if (on) {
			next.add(id);
		} else {
			next.delete(id);
		}
		onChange(next);
	};
	return (
		<div className="space-y-2">
			<PickerHeader
				hint={`${chosen.size} of ${list.length} chosen`}
				allOn={chosen.size === list.length}
				noneOn={chosen.size === 0}
				onAll={() => onChange(new Set(list.map((p) => p.id)))}
				onClear={() => onChange(new Set())}
			/>
			{list.length > 8 && <Filter value={filter} onChange={setFilter} label="Filter playlists" />}
			<CheckList>
				{shown.map((p) => (
					<CheckRow
						key={p.id}
						label={p.name}
						detail={plural(p.trackCount, "track", "tracks")}
						note={onDrive.has(p.name) ? "Replaces the one on the drive" : undefined}
						icon={<ListMusic className="size-4" />}
						state={chosen.has(p.id) ? "on" : "off"}
						onChange={(on) => toggle(p.id, on)}
					/>
				))}
				{shown.length === 0 && (
					<p className="px-3 py-2 text-muted-foreground text-sm">No playlist matches.</p>
				)}
			</CheckList>
		</div>
	);
}

function TagPicker({
	tags,
	chosen,
	onDrive,
	chosenPlaylistNames,
	onChange,
}: {
	tags: readonly Tag[];
	chosen: readonly string[];
	onDrive: ReadonlySet<string>;
	/** Library playlists also being exported; a tag with the same name would overwrite one. */
	chosenPlaylistNames: ReadonlySet<string>;
	onChange: (next: string[]) => void;
}) {
	if (tags.length === 0) {
		return <p className="py-6 text-center text-muted-foreground text-sm">No tagged songs yet.</p>;
	}
	return (
		<div className="space-y-2">
			<PickerHeader
				hint="Each tag becomes a playlist of its songs, including tags below it"
				allOn={chosen.length >= tags.length}
				noneOn={chosen.length === 0}
				onAll={() => onChange(tags.map((t) => t.name))}
				onClear={() => onChange([])}
			/>
			<TagTree
				tags={tags}
				selected={chosen}
				onChange={onChange}
				noteFor={(n) => {
					const name = tagPlaylistName(n.name);
					if (chosenPlaylistNames.has(name)) {
						return "Same name as a chosen playlist";
					}
					return onDrive.has(name) ? "Replaces the one on the drive" : undefined;
				}}
			/>
		</div>
	);
}

const STEPS: [UsbExportProgress["phase"], string][] = [
	["copying", "Copy songs"],
	["analyzing", "Beat grids and waveforms"],
	["writing", "Write the rekordbox library"],
];

/** The three things an export does, in order, with the current one's progress. */
function Steps({ progress }: { progress: UsbExportProgress | null }) {
	const at = progress ? STEPS.findIndex(([p]) => p === progress.phase) : -1;
	return (
		<ol className="space-y-3" aria-live="polite">
			{STEPS.map(([phase, label], i) => {
				const done = i < at;
				const current = i === at;
				const pct =
					current && progress && progress.total > 0
						? Math.round((progress.done / progress.total) * 100)
						: 0;
				return (
					<li key={phase} className="flex gap-3">
						<span
							className={cn(
								"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
								done && "border-transparent bg-primary text-primary-foreground",
								current && "border-primary text-primary",
								!done && !current && "text-muted-foreground",
							)}
						>
							{done ? <Check className="size-3" /> : i + 1}
						</span>
						<div className="min-w-0 flex-1 space-y-1.5">
							<p className={cn("text-sm", !done && !current && "text-muted-foreground")}>{label}</p>
							{current && progress && phase !== "writing" && progress.total > 0 && (
								<>
									<div className="flex justify-between gap-3 text-muted-foreground text-xs">
										<span className="min-w-0 truncate">{progress.current}</span>
										<span className="shrink-0 tabular-nums">
											{Math.min(progress.done + 1, progress.total)} of {progress.total}
										</span>
									</div>
									<div className="h-1 overflow-hidden rounded-full bg-muted">
										<div
											className="h-full bg-primary transition-[width] motion-reduce:transition-none"
											style={{ width: `${pct}%` }}
										/>
									</div>
								</>
							)}
						</div>
					</li>
				);
			})}
			{progress === null && <li className="text-muted-foreground text-sm">Reading the drive…</li>}
		</ol>
	);
}

function Summary({ report, drive }: { report: UsbExportReport; drive: UsbDrive }) {
	return (
		<div className="space-y-4">
			<div className="flex items-start gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
					<Check className="size-5" />
				</span>
				<div className="min-w-0">
					<p className="font-medium">
						{plural(report.playlists, "playlist", "playlists")} on {drive.name}
					</p>
					<p className="text-muted-foreground text-sm">
						{plural(report.libraryTracks, "track", "tracks")} in the drive's library now
					</p>
				</div>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border bg-card p-4 text-sm">
				<dt className="text-muted-foreground">Copied</dt>
				<dd className="tabular-nums">
					{plural(report.copied, "song", "songs")}, {formatBytes(report.bytesCopied)}
				</dd>
				<dt className="text-muted-foreground">Already there</dt>
				<dd className="tabular-nums">{plural(report.alreadyThere, "song", "songs")}</dd>
				{report.analyzed > 0 && (
					<>
						<dt className="text-muted-foreground">Analysed</dt>
						<dd className="tabular-nums">{plural(report.analyzed, "song", "songs")}</dd>
					</>
				)}
				{report.regridded > 0 && (
					<>
						<dt className="text-muted-foreground">Grids updated</dt>
						<dd className="tabular-nums">{plural(report.regridded, "song", "songs")}</dd>
					</>
				)}
				<dt className="text-muted-foreground">Players</dt>
				<dd>
					{report.oneLibrary ? "Every Pioneer and AlphaTheta player" : "CDJ-3000 and older only"}
				</dd>
				{report.backup && (
					<>
						<dt className="text-muted-foreground">Previous library</dt>
						<dd className="min-w-0 truncate" title={report.backup}>
							<code className="text-xs">{report.backup}</code>
						</dd>
					</>
				)}
			</dl>
			{report.oneLibraryError && (
				<p className="text-destructive text-xs">
					The OneLibrary for the CDJ-3000X, Opus Quad, XDJ-AZ and Omnis Duo could not be written, so
					the old one was removed: {report.oneLibraryError}
				</p>
			)}
			{report.failed.length > 0 && (
				<div className="space-y-1">
					<p className="font-medium text-destructive text-sm">
						{plural(report.failed.length, "song", "songs")} not exported
					</p>
					<ul className="space-y-1 text-xs">
						{report.failed.map((f) => (
							<li key={f.path} className="truncate" title={`${f.path}: ${f.error}`}>
								{f.path.split("/").pop()}: {f.error}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function exportLabel(count: number): string {
	return count === 0 ? "Export" : `Export ${plural(count, "playlist", "playlists")}`;
}

/** Everything the export drawer shows: what is chosen, what it adds up to, and the run. */
function useUsbExport(drive: UsbDrive, library: UsbLibrary | undefined, open: boolean) {
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<Tab>("playlists");
	const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
	const [chosenTags, setChosenTags] = useState<string[]>([]);
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists, enabled: open });
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: open });
	const run = useMutation({
		mutationFn: () => exportToUsb(drive.mount, [...chosen], chosenTags),
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["usb-library", drive.mount] });
			await queryClient.invalidateQueries({ queryKey: ["usb-formats", drive.mount] });
			await queryClient.invalidateQueries({ queryKey: ["usb-drives"] });
		},
	});
	const progress = useExportProgress(run.isPending);
	const estimate = useEstimate(open ? [...chosen] : [], open ? chosenTags : [], library);
	return {
		drive,
		tab,
		setTab,
		chosen,
		setChosen,
		chosenTags,
		setChosenTags,
		playlists,
		tags,
		run,
		progress,
		estimate,
		onDrive: new Set(
			(library?.playlists ?? []).filter((p) => p.parentId === 0 && !p.isFolder).map((p) => p.name),
		),
		count: chosen.size + chosenTags.length,
		fits: estimate.bytes + HEADROOM <= drive.freeBytes,
	};
}

type ExportState = ReturnType<typeof useUsbExport>;

function Chooser({ x }: { x: ExportState }) {
	const list = (x.playlists.data ?? []).filter((p) => p.trackCount > 0);
	const tagList = (x.tags.data ?? []).filter((t) => t.trackCount > 0);
	const chosenNames = new Set(list.filter((p) => x.chosen.has(p.id)).map((p) => p.name));
	return (
		<div className="space-y-3">
			<Segmented
				value={x.tab}
				onChange={x.setTab}
				label="What to export"
				items={[
					{ value: "playlists", label: "Playlists", icon: <ListMusic />, count: x.chosen.size },
					{ value: "tags", label: "Tags", icon: <TagIcon />, count: x.chosenTags.length },
				]}
			/>
			{x.playlists.isError && <ErrorText message={String(x.playlists.error)} />}
			{x.tags.isError && <ErrorText message={String(x.tags.error)} />}
			{x.tab === "playlists" && x.playlists.isSuccess && (
				<PlaylistPicker list={list} chosen={x.chosen} onDrive={x.onDrive} onChange={x.setChosen} />
			)}
			{x.tab === "tags" && x.tags.isSuccess && (
				<TagPicker
					tags={tagList}
					chosen={x.chosenTags}
					onDrive={x.onDrive}
					chosenPlaylistNames={chosenNames}
					onChange={x.setChosenTags}
				/>
			)}
		</div>
	);
}

function Body({ x }: { x: ExportState }) {
	if (x.run.isSuccess) {
		return <Summary report={x.run.data} drive={x.drive} />;
	}
	if (x.run.isPending) {
		return <Steps progress={x.progress} />;
	}
	return <Chooser x={x} />;
}

/** The footer line: what the choice adds up to, or what to do now. */
function status(x: ExportState): { text: string; warn: boolean } {
	if (x.run.isSuccess) {
		return { text: "Eject the drive before unplugging it", warn: false };
	}
	if (x.run.isPending) {
		return { text: "Keep the drive plugged in", warn: false };
	}
	if (x.count === 0) {
		return { text: "Choose playlists or tags", warn: false };
	}
	if (x.estimate.loading) {
		return { text: "Counting songs…", warn: false };
	}
	if (!x.fits) {
		return { text: "Probably too big for the drive", warn: true };
	}
	const { songs, toCopy } = x.estimate;
	return {
		text: `${plural(songs, "song", "songs")}, ${toCopy.toLocaleString()} to copy`,
		warn: false,
	};
}

function Footer({ x, onClose }: { x: ExportState; onClose: () => void }) {
	const line = status(x);
	return (
		<div className="-mx-4 -mb-4 sticky bottom-0 z-10 flex items-center gap-3 border-t bg-background/85 px-4 py-3 backdrop-blur-md">
			<p
				className={cn(
					"min-w-0 flex-1 truncate text-sm tabular-nums",
					line.warn ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{line.text}
			</p>
			{x.run.isSuccess ? (
				<Button onClick={onClose}>Done</Button>
			) : (
				<>
					<Button variant="ghost" onClick={onClose} disabled={x.run.isPending}>
						Cancel
					</Button>
					<Button
						onClick={() => x.run.mutate()}
						disabled={x.count === 0 || x.run.isPending}
						title="Copies new songs into /Contents, adds beat grids and waveforms, and adds the playlists. Songs already on the drive are not copied again."
					>
						{x.run.isPending ? "Exporting…" : exportLabel(x.count)}
					</Button>
				</>
			)}
		</div>
	);
}

/** Picks library playlists and tags and copies them onto the drive as playlists. */
export function UsbExportButton({
	drive,
	library,
}: {
	drive: UsbDrive;
	library: UsbLibrary | undefined;
}) {
	const [open, setOpen] = useState(false);
	const x = useUsbExport(drive, library, open);
	const close = () => {
		if (!x.run.isPending) {
			setOpen(false);
			x.run.reset();
		}
	};
	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)} disabled={!drive.writable}>
				<HardDriveUpload /> Export to drive…
			</Button>
			<Drawer open={open} onClose={close} title={`Export to ${drive.name}`} width="w-[32rem]">
				<div className="flex min-h-full flex-col">
					<div className="flex-1 space-y-5 pb-6">
						<div className="space-y-3">
							<h2 className={cn("truncate", typeScale.panelTitle)}>{drive.name}</h2>
							<SpaceMeter drive={drive} adding={x.run.isSuccess ? 0 : x.estimate.bytes} />
						</div>
						<Body x={x} />
						{x.run.isError && <ErrorText message={String(x.run.error)} />}
					</div>
					<Footer x={x} onClose={close} />
				</div>
			</Drawer>
		</>
	);
}
