import { Menu } from "@base-ui/react/menu";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronDown,
	HardDrive,
	HardDriveUpload,
	ListPlus,
	ListX,
	type LucideIcon,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import {
	type ChooserTab,
	ExportChooser,
	ExportFooter,
	type HeldPlaylist,
	HeldPlaylists,
} from "#/components/export-chooser.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ButtonGroup } from "#/components/ui/button-group.tsx";
import { UsbOutputsPicker } from "#/components/usb-outputs.tsx";
import { type PlaylistSource, Review, ReviewCounts } from "#/components/usb-review.tsx";
import {
	type ExportSelection,
	exportToUsb,
	listPlaylists,
	listTags,
	onUsbExportProgress,
	playlistTracks,
	type SmartRules,
	smartPlaylistPreview,
	type Track,
	type UsbDiff,
	type UsbDrive,
	type UsbExportProgress,
	type UsbExportReport,
	type UsbLibrary,
	type UsbMode,
	type UsbOutputs,
	usbExportPreview,
	usbExportSelection,
} from "#/lib/api.ts";
import { EMPTY_SELECTION, plural, tagPlaylistName } from "#/lib/export-selection.ts";
import { formatBytes } from "#/lib/format.ts";
import { baseName } from "#/lib/fs-path.ts";
import { useTracks } from "#/lib/queries.ts";
import { trackHasTag } from "#/lib/tag-tree.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { exportSteps, outputProblems, outputResults } from "#/lib/usb-outputs.ts";
import { useSmartPlaylists } from "#/lib/use-smart.ts";
import { cn } from "#/lib/utils.ts";

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

/**
 * Size of every chosen song by id: the playlists' songs, then songs carrying a chosen tag, then
 * the songs the chosen smart playlists pick.
 */
function chosenSongs(
	fromPlaylists: readonly Track[],
	library: readonly Track[],
	tags: readonly string[],
	fromSmart: readonly number[],
): Map<number, number> {
	const songs = new Map(fromPlaylists.map((t) => [t.id, t.size]));
	const smart = new Set(fromSmart);
	for (const t of library) {
		if (smart.has(t.id) || tags.some((name) => trackHasTag(t, name))) {
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
	smart: readonly SmartRules[],
	library: UsbLibrary | undefined,
): Estimate {
	const tracks = useTracks();
	const lists = useQueries({
		queries: playlistIds.map((id) => ({
			queryKey: ["playlist-tracks", id],
			queryFn: () => playlistTracks(id),
		})),
	});
	const previews = useQueries({
		queries: smart.map((rules) => ({
			queryKey: ["smart-preview", rules],
			queryFn: () => smartPlaylistPreview(rules),
		})),
	});
	const needLibrary = tags.length > 0 || smart.length > 0;
	const sizes = useMemo(() => new Set((library?.tracks ?? []).map((t) => t.fileSize)), [library]);
	const songs = chosenSongs(
		lists.flatMap((q) => q.data ?? []),
		needLibrary ? (tracks.data ?? []) : [],
		tags,
		previews.flatMap((q) => q.data?.trackIds ?? []),
	);
	const fresh = [...songs.values()].filter((size) => !sizes.has(size));
	const bytes = fresh.reduce((n, size) => n + size, 0);
	const toCopy = fresh.length;
	return {
		songs: songs.size,
		toCopy,
		bytes,
		loading:
			lists.some((q) => q.isPending) ||
			previews.some((q) => q.isPending) ||
			(needLibrary && tracks.isPending),
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

/** The bar under the step that is running: how far it is, or just that it is working. */
function StepProgress({ progress }: { progress: UsbExportProgress | null }) {
	const counted = progress !== null && progress.total > 0;
	const pct = counted ? Math.round((progress.done / progress.total) * 100) : 0;
	const doing = progress === null ? "Reading the drive…" : progress.current || "Working…";
	return (
		<>
			<div className="flex justify-between gap-3 text-muted-foreground text-xs">
				<span className="min-w-0 truncate">{doing}</span>
				{counted && (
					<span className="shrink-0 tabular-nums">
						{Math.min(progress.done + 1, progress.total)} of {progress.total}
					</span>
				)}
			</div>
			<div className="h-1 overflow-hidden rounded-full bg-muted">
				<div
					className={cn(
						"h-full bg-primary transition-[width] motion-reduce:transition-none",
						!counted && "w-full animate-pulse motion-reduce:animate-none",
					)}
					style={counted ? { width: `${pct}%` } : undefined}
				/>
			</div>
		</>
	);
}

/** What an export does, in order, with the current step's progress. */
function Steps({ progress, outputs }: { progress: UsbExportProgress | null; outputs: UsbOutputs }) {
	const all = exportSteps(outputs);
	// Before the first report the drive is being read, which is part of the first step.
	const at = progress ? all.findIndex(([p]) => p === progress.phase) : 0;
	return (
		<ol className="space-y-3" aria-live="polite">
			{all.map(([phase, label], i) => {
				const done = i < at;
				const current = i === at;
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
							{current && <StepProgress progress={progress} />}
						</div>
					</li>
				);
			})}
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
						{plural(report.playlists, "playlist")} on {drive.name}
					</p>
					<p className="text-muted-foreground text-sm">
						{plural(report.libraryTracks, "track")} in the drive's library now
					</p>
				</div>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border bg-card p-4 text-sm">
				<dt className="text-muted-foreground">Copied</dt>
				<dd className="tabular-nums">
					{plural(report.copied, "song")}, {formatBytes(report.bytesCopied)}
				</dd>
				{report.playlistsRemoved > 0 && (
					<>
						<dt className="text-muted-foreground">Removed</dt>
						<dd className="tabular-nums">
							{plural(report.playlistsRemoved, "playlist or folder", "playlists and folders")}
						</dd>
					</>
				)}
				{report.songsDeleted > 0 && (
					<>
						<dt className="text-muted-foreground">Deleted</dt>
						<dd className="tabular-nums">
							{plural(report.songsDeleted, "song")}, {formatBytes(report.bytesFreed)} freed
						</dd>
					</>
				)}
				<dt className="text-muted-foreground">Already there</dt>
				<dd className="tabular-nums">{plural(report.alreadyThere, "song")}</dd>
				{report.analyzed > 0 && (
					<>
						<dt className="text-muted-foreground">Analysed</dt>
						<dd className="tabular-nums">{plural(report.analyzed, "song")}</dd>
					</>
				)}
				{report.regridded > 0 && (
					<>
						<dt className="text-muted-foreground">Grids updated</dt>
						<dd className="tabular-nums">{plural(report.regridded, "song")}</dd>
					</>
				)}
				{outputResults(report).map((result) => (
					<div key={result.label} className="contents">
						<dt className="text-muted-foreground">{result.label}</dt>
						<dd className="tabular-nums">{result.text}</dd>
					</div>
				))}
				{report.backup && (
					<>
						<dt className="text-muted-foreground">Previous library</dt>
						<dd className="min-w-0 truncate" title={report.backup}>
							<code className="text-xs">{report.backup}</code>
						</dd>
					</>
				)}
			</dl>
			{outputProblems(report).map((problem) => (
				<ErrorLine key={problem}>{problem}</ErrorLine>
			))}
			{report.failed.length > 0 && (
				<div className="space-y-1">
					<p className="font-medium text-destructive text-sm">
						{plural(report.failed.length, "song")} not exported
					</p>
					<ul className="space-y-1 text-xs">
						{report.failed.map((f) => (
							<li key={f.path} className="truncate" title={`${f.path}: ${f.error}`}>
								{baseName(f.path)}: {f.error}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** The drive's playlists with their folders and songs, for the "On drive" tab. */
function heldPlaylists(library: UsbLibrary, removing: ReadonlySet<number>): HeldPlaylist[] {
	const byId = new Map(library.playlists.map((p) => [p.id, p]));
	const songs = new Map(library.tracks.map((t) => [t.id, t]));
	const folders = (parentId: number): string[] => {
		const names: string[] = [];
		for (let p = byId.get(parentId); p && names.length < 32; p = byId.get(p.parentId)) {
			names.unshift(p.name);
		}
		return names;
	};
	return library.playlists
		.filter((p) => !p.isFolder)
		.sort((x, y) => x.sortOrder - y.sortOrder)
		.map((p) => ({
			folders: folders(p.parentId),
			name: p.name,
			removed: removing.has(p.id),
			tracks: p.trackIds.flatMap((id) => {
				const t = songs.get(id);
				return t ? [{ title: t.title, artist: t.artist }] : [];
			}),
		}));
}

/**
 * The choice the drawer opens with: what was last exported to this drive, else the library
 * playlists and tags whose names the drive's playlists already have.
 */
function startingSelection(
	saved: ExportSelection | null | undefined,
	onDrive: ReadonlySet<string>,
	playlists: readonly { id: number; name: string }[],
	tags: readonly { name: string }[],
): ExportSelection {
	if (saved) {
		return saved;
	}
	return {
		playlists: playlists.filter((p) => onDrive.has(p.name)).map((p) => p.id),
		tags: tags.filter((t) => onDrive.has(tagPlaylistName(t.name))).map((t) => t.name),
		smart: [],
		usbMode: "add",
		usbOutputs: EMPTY_SELECTION.usbOutputs,
	};
}

/** Everything the export drawer shows: what is chosen, what it adds up to, and the run. */
function useUsbExport(drive: UsbDrive, library: UsbLibrary | undefined, open: boolean) {
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<ChooserTab>("playlists");
	const [draft, setDraft] = useState<ExportSelection | null>(null);
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists, enabled: open });
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: open });
	const saved = useQuery({
		queryKey: ["usb-export-selection", drive.id],
		queryFn: () => usbExportSelection(drive.id),
		enabled: open,
	});
	const onDrive = useMemo(
		() =>
			new Set(
				(library?.playlists ?? [])
					.filter((p) => p.parentId === 0 && !p.isFolder)
					.map((p) => p.name),
			),
		[library],
	);
	const ready = saved.isSuccess && playlists.isSuccess && tags.isSuccess;
	const selection =
		draft ??
		(ready ? startingSelection(saved.data, onDrive, playlists.data, tags.data) : EMPTY_SELECTION);
	/** The changes the export would make, shown for a yes before anything is written. */
	const review = useMutation({
		mutationFn: () => usbExportPreview(drive.mount, selection),
	});
	const run = useMutation({
		mutationFn: () => exportToUsb(drive.mount, selection),
		onSuccess: () => {
			setDraft(null);
			review.reset();
		},
		onSettled: async () => {
			for (const key of [
				["usb-library", drive.mount],
				["usb-formats", drive.mount],
				["usb-drives"],
				["usb-export-selection", drive.id],
			]) {
				await queryClient.invalidateQueries({ queryKey: key });
			}
		},
	});
	const progress = useExportProgress(run.isPending);
	const smart = useSmartPlaylists();
	const chosenSmart = (smart.data ?? []).filter((p) => selection.smart.includes(p.id));
	const estimate = useEstimate(
		open ? selection.playlists : [],
		open ? selection.tags : [],
		open ? chosenSmart.map((p) => p.rules) : [],
		library,
	);
	const ids = new Set((playlists.data ?? []).map((p) => p.id));
	// Same order as the export writes them, so a later one with the same name wins here too.
	const sources = new Map<string, PlaylistSource>([
		...(playlists.data ?? [])
			.filter((p) => selection.playlists.includes(p.id))
			.map((p): [string, PlaylistSource] => [p.name, "playlist"]),
		...selection.tags.map((t): [string, PlaylistSource] => [tagPlaylistName(t), "tag"]),
		...chosenSmart.map((p): [string, PlaylistSource] => [p.name, "smart"]),
	]);
	const exportNames = new Set([
		...(playlists.data ?? []).filter((p) => selection.playlists.includes(p.id)).map((p) => p.name),
		...selection.tags.map(tagPlaylistName),
		...chosenSmart.map((p) => p.name),
	]);
	const removing =
		selection.usbMode !== "add" ? removedByExport(library, exportNames) : new Set<number>();
	return {
		drive,
		removing,
		sourceOf: (name: string): PlaylistSource => sources.get(name) ?? "playlist",
		/** Playlists (not folders) the export takes off the drive. */
		removingCount: (library?.playlists ?? []).filter((p) => !p.isFolder && removing.has(p.id))
			.length,
		library,
		tab,
		setTab,
		selection,
		setDraft,
		run,
		progress,
		estimate,
		onDrive,
		review,
		count:
			selection.playlists.filter((id) => ids.has(id)).length +
			selection.tags.length +
			chosenSmart.length,
		fits: estimate.bytes + HEADROOM <= drive.freeBytes,
	};
}

/**
 * Ids of the drive's playlists and folders that an export removing the rest takes away: all but
 * the top-level playlists it writes again.
 */
function removedByExport(
	library: UsbLibrary | undefined,
	exportNames: ReadonlySet<string>,
): Set<number> {
	return new Set(
		(library?.playlists ?? [])
			.filter((p) => !(p.parentId === 0 && !p.isFolder && exportNames.has(p.name)))
			.map((p) => p.id),
	);
}

type ExportState = ReturnType<typeof useUsbExport>;

function Body({ x, onLeave }: { x: ExportState; onLeave: () => void }) {
	if (x.run.isSuccess) {
		return <Summary report={x.run.data} drive={x.drive} />;
	}
	if (x.run.isPending) {
		return <Steps progress={x.progress} outputs={x.selection.usbOutputs} />;
	}
	if (x.review.isSuccess) {
		return (
			<Review
				diff={x.review.data}
				mode={x.selection.usbMode}
				outputs={x.selection.usbOutputs}
				sourceOf={x.sourceOf}
			/>
		);
	}
	return (
		<ExportChooser
			selection={x.selection}
			onChange={x.setDraft}
			tab={x.tab}
			onTab={x.setTab}
			replaces={x.onDrive}
			onLeave={onLeave}
			destination={{
				label: "On drive",
				icon: <HardDrive />,
				content: x.library ? (
					<HeldPlaylists
						playlists={heldPlaylists(x.library, x.removing)}
						empty="No playlists on the drive yet."
					/>
				) : (
					<p className="text-muted-foreground text-sm">Reading the drive…</p>
				),
			}}
		/>
	);
}

/** The footer line: what the choice adds up to, or what to do now. */
function status(x: ExportState): { text: ReactNode; warn: boolean } {
	if (x.run.isSuccess) {
		return { text: "Eject the drive before unplugging it", warn: false };
	}
	if (x.run.isPending) {
		return { text: "Keep the drive plugged in", warn: false };
	}
	if (x.review.isPending) {
		return { text: "Working out the changes…", warn: false };
	}
	if (x.review.isSuccess) {
		return { text: <ReviewCounts diff={x.review.data} />, warn: false };
	}
	if (x.count === 0) {
		return { text: "Choose playlists, tags or smart playlists", warn: false };
	}
	if (x.estimate.loading) {
		return { text: "Counting songs…", warn: false };
	}
	if (!x.fits) {
		return { text: "Probably too big for the drive", warn: true };
	}
	const { songs, toCopy } = x.estimate;
	const sizes = `${plural(songs, "song")}, ${toCopy.toLocaleString()} to copy`;
	if (x.removingCount > 0) {
		return {
			text: `${sizes}. Removes ${plural(x.removingCount, "other playlist")}`,
			warn: true,
		};
	}
	return { text: sizes, warn: false };
}

const MODES: readonly { value: UsbMode; icon: LucideIcon; title: string; detail: string }[] = [
	{
		value: "add",
		icon: ListPlus,
		title: "Add to the drive",
		detail: "Playlists already on the drive stay.",
	},
	{
		value: "replacePlaylists",
		icon: ListX,
		title: "Replace the drive's playlists",
		detail: "Removes playlists not chosen here. Songs stay on the drive.",
	},
	{
		value: "replaceAll",
		icon: Trash2,
		title: "Replace playlists and delete songs",
		detail: "Removes playlists not chosen here, then deletes songs no exported playlist holds.",
	},
];

function confirmLabel(mode: UsbMode, diff: UsbDiff): string {
	if (mode === "replaceAll" && diff.delete.length > 0) {
		return `Export and delete ${plural(diff.delete.length, "song")}`;
	}
	return mode === "add" ? "Export" : "Export and replace";
}

/**
 * Review, with a menu beside it choosing what happens to what is already on the drive. The
 * choice is saved for the drive with the export.
 */
function ReviewSplitButton({ x }: { x: ExportState }) {
	const busy = x.review.isPending;
	return (
		<ButtonGroup>
			<Button onClick={() => x.review.mutate()} disabled={x.count === 0 || busy}>
				{busy ? "Checking the drive…" : `Review ${plural(x.count, "playlist")}`}
			</Button>
			<Menu.Root>
				<Menu.Trigger
					disabled={busy}
					render={
						<Button aria-label="What happens on the drive" style={{ paddingInline: "0.5rem" }} />
					}
				>
					<ChevronDown />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner side="top" align="end" sideOffset={6} className="z-50">
						<Menu.Popup className="w-80 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
							<Menu.RadioGroup
								value={x.selection.usbMode}
								onValueChange={(v: string) => x.setDraft({ ...x.selection, usbMode: v as UsbMode })}
							>
								{MODES.map((m) => (
									<Menu.RadioItem
										key={m.value}
										value={m.value}
										closeOnClick
										className="flex cursor-default items-start gap-3 rounded-md px-2 py-2 outline-none data-[highlighted]:bg-muted"
									>
										<m.icon
											className={cn(
												"mt-0.5 size-4 shrink-0",
												m.value === "add" ? "text-muted-foreground" : "text-destructive",
											)}
										/>
										<span className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="font-medium text-sm">{m.title}</span>
											<span className="text-muted-foreground text-xs">{m.detail}</span>
										</span>
										<Menu.RadioItemIndicator className="mt-0.5 text-primary">
											<Check className="size-4" />
										</Menu.RadioItemIndicator>
									</Menu.RadioItem>
								))}
							</Menu.RadioGroup>
							<p className="px-2 pt-1.5 pb-1 text-muted-foreground text-xs">
								You see every change before anything is written. Remembered for {x.drive.name}.
							</p>
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</ButtonGroup>
	);
}

function Footer({ x, onClose }: { x: ExportState; onClose: () => void }) {
	const line = status(x);
	return (
		<ExportFooter text={line.text} warn={line.warn}>
			{x.run.isSuccess ? (
				<Button onClick={onClose}>Done</Button>
			) : (
				<>
					{x.review.isSuccess ? (
						<Button variant="ghost" onClick={() => x.review.reset()} disabled={x.run.isPending}>
							Back
						</Button>
					) : (
						<Button variant="ghost" onClick={onClose} disabled={x.run.isPending}>
							Cancel
						</Button>
					)}
					{x.review.isSuccess ? (
						<Button
							variant={x.review.data.delete.length > 0 ? "destructive" : "default"}
							onClick={() => x.run.mutate()}
							disabled={x.run.isPending}
						>
							{x.run.isPending ? "Exporting…" : confirmLabel(x.selection.usbMode, x.review.data)}
						</Button>
					) : (
						<ReviewSplitButton x={x} />
					)}
				</>
			)}
		</ExportFooter>
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
			x.review.reset();
			x.setDraft(null);
			x.setTab("playlists");
		}
	};
	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)} disabled={!drive.writable}>
				<HardDriveUpload /> Export to drive…
			</Button>
			<Drawer
				open={open}
				onClose={close}
				title={`Export to ${drive.name}`}
				width={x.review.isSuccess ? "w-[40rem]" : "w-[32rem]"}
			>
				<div className="flex min-h-full flex-col">
					<div className="flex-1 space-y-5 pb-6">
						<div className="space-y-3">
							<h2 className={cn("truncate", typeScale.panelTitle)}>{drive.name}</h2>
							<SpaceMeter drive={drive} adding={x.run.isSuccess ? 0 : x.estimate.bytes} />
						</div>
						{!x.review.isSuccess && !x.run.isPending && !x.run.isSuccess && (
							<UsbOutputsPicker
								outputs={x.selection.usbOutputs}
								onChange={(usbOutputs) => x.setDraft({ ...x.selection, usbOutputs })}
							/>
						)}
						<Body x={x} onLeave={close} />
						{x.review.isError && <ErrorLine>{String(x.review.error)}</ErrorLine>}
						{x.run.isError && <ErrorLine>{String(x.run.error)}</ErrorLine>}
					</div>
					<Footer x={x} onClose={close} />
				</div>
			</Drawer>
		</>
	);
}
