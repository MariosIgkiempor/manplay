import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, ListMusic, Music, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { SourceCard } from "#/components/source-card.tsx";
import { SectionTitle, SourcePanel } from "#/components/source-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { type UsbDrive, type UsbLibrary, type UsbTrack, usbDrives, usbLibrary } from "#/lib/api.ts";
import { clock, formatBytes } from "#/lib/format.ts";
import { formatBpm } from "#/lib/musical-key.ts";
import { useServices } from "#/lib/queries.ts";
import { playlistTree } from "#/lib/usb-library.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Plugged-in drives, re-checked every few seconds so plugging one in shows up on its own. */
function useUsbDrives(enabled = true) {
	return useQuery({
		queryKey: ["usb-drives"],
		queryFn: usbDrives,
		refetchInterval: 3000,
		enabled,
	});
}

function useUsbLibrary(mount: string | null) {
	return useQuery({
		queryKey: ["usb-library", mount],
		queryFn: () => usbLibrary(mount ?? ""),
		enabled: mount !== null,
	});
}

function useUsbService() {
	const services = useServices();
	return {
		enabled: services.isEnabled("usb", true),
		setEnabled: (on: boolean) => services.setEnabled("usb", on),
	};
}

function space(d: UsbDrive): string {
	return `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`;
}

export function UsbCard() {
	const detail = useDetail();
	const { enabled, setEnabled } = useUsbService();
	const drives = useUsbDrives(enabled);
	const list = drives.data ?? [];
	const open = () => detail.open({ kind: "service", service: "usb" });
	const subtitle =
		list.length === 0 ? "No USB drive plugged in" : list.map((d) => d.name).join(", ");
	const withLibrary = list.filter((d) => d.hasLibrary).length;
	const status =
		list.length === 0
			? "Plug in a USB drive to see what's on it"
			: `${plural(list.length, "drive", "drives")} · ${withLibrary} with a rekordbox library`;
	return (
		<SourceCard
			brand="usb"
			title="CDJ USB"
			subtitle={subtitle}
			enabled={enabled}
			onToggle={setEnabled}
			status={status}
			onOpen={open}
			action={
				<Button size="sm" variant="outline" onClick={open} disabled={list.length === 0}>
					Browse
				</Button>
			}
		/>
	);
}

function DriveRow({ drive, onOpen }: { drive: UsbDrive; onOpen: () => void }) {
	const library = useUsbLibrary(drive.hasLibrary ? drive.mount : null);
	let contents: string;
	if (!drive.hasLibrary) {
		contents = "No rekordbox library yet";
	} else if (library.data) {
		contents = `${plural(library.data.tracks.length, "track", "tracks")} · ${plural(
			library.data.playlists.filter((p) => !p.isFolder).length,
			"playlist",
			"playlists",
		)}`;
	} else {
		contents = library.isError ? "Could not read its library" : "Reading library…";
	}
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted/40"
			>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-sm">{drive.name}</span>
					<span className="block truncate text-muted-foreground text-xs">
						{contents} · {space(drive)}
						{drive.filesystem && ` · ${drive.filesystem.toUpperCase()}`}
					</span>
				</span>
				<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
			</button>
		</li>
	);
}

export function UsbPanel() {
	const { enabled, setEnabled } = useUsbService();
	const drives = useUsbDrives(enabled);
	const [selected, setSelected] = useState<string | null>(null);
	const list = drives.data ?? [];
	const drive = list.find((d) => d.mount === selected);
	return (
		<SourcePanel
			brand="usb"
			title="CDJ USB"
			subtitle="USB drives for Pioneer CDJs and XDJs. Plug one in to browse the rekordbox library on it."
			enabled={enabled}
			onToggle={setEnabled}
		>
			<section className="space-y-2">
				<SectionTitle>Plugged in</SectionTitle>
				{drives.isError && <ErrorText message={String(drives.error)} />}
				{list.length === 0 ? (
					<p className="py-6 text-center text-muted-foreground text-sm">
						No USB drives plugged in.
					</p>
				) : (
					<ul className="divide-y">
						{list.map((d) => (
							<DriveRow key={d.mount} drive={d} onOpen={() => setSelected(d.mount)} />
						))}
					</ul>
				)}
			</section>
			<Drawer
				open={drive !== undefined}
				onClose={() => setSelected(null)}
				title={drive?.name ?? ""}
				width="w-[56rem]"
			>
				{drive && <DriveDetail drive={drive} />}
			</Drawer>
		</SourcePanel>
	);
}

type View = { kind: "all" } | { kind: "playlist"; id: number };

function DriveDetail({ drive }: { drive: UsbDrive }) {
	const library = useUsbLibrary(drive.hasLibrary ? drive.mount : null);
	const [view, setView] = useState<View>({ kind: "all" });

	return (
		<div className="space-y-4 pb-6">
			<div className="space-y-1">
				<h2 className="font-semibold text-xl tracking-tight">{drive.name}</h2>
				<p className="text-muted-foreground text-sm">
					{drive.mount} · {space(drive)}
					{drive.filesystem && ` · ${drive.filesystem.toUpperCase()}`}
					{!drive.writable && " · read-only"}
				</p>
			</div>
			{drive.hasOneLibrary && (
				<p className="flex gap-2 rounded-lg border p-3 text-muted-foreground text-xs">
					<TriangleAlert className="size-4 shrink-0" />
					Rekordbox also wrote a OneLibrary database here, which the CDJ-3000X, Opus Quad, XDJ-AZ
					and Omnis Duo read. This view shows the Device Library that other players read.
				</p>
			)}
			{!drive.hasLibrary && (
				<p className="py-10 text-center text-muted-foreground text-sm">
					This drive has no rekordbox library yet.
				</p>
			)}
			{library.isError && <ErrorText message={String(library.error)} />}
			{library.isPending && drive.hasLibrary && (
				<p className="py-10 text-center text-muted-foreground text-sm">Reading library…</p>
			)}
			{library.data && <LibraryBrowser library={library.data} view={view} onView={setView} />}
		</div>
	);
}

function LibraryBrowser({
	library,
	view,
	onView,
}: {
	library: UsbLibrary;
	view: View;
	onView: (v: View) => void;
}) {
	const tree = useMemo(() => playlistTree(library.playlists), [library.playlists]);
	const byId = useMemo(() => new Map(library.tracks.map((t) => [t.id, t])), [library.tracks]);
	const playlist =
		view.kind === "playlist" ? library.playlists.find((p) => p.id === view.id) : undefined;
	const tracks = playlist ? playlist.trackIds.flatMap((id) => byId.get(id) ?? []) : library.tracks;

	return (
		<div className="grid grid-cols-[14rem_minmax(0,1fr)] gap-4">
			<nav aria-label="Playlists" className="space-y-0.5 text-sm">
				<SidebarItem
					active={view.kind === "all"}
					onClick={() => onView({ kind: "all" })}
					icon={<Music className="size-4" />}
					label="All tracks"
					count={library.tracks.length}
					depth={0}
				/>
				{tree.map(({ playlist: p, depth }) =>
					p.isFolder ? (
						<div
							key={p.id}
							className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground"
							style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
						>
							<Folder className="size-4 shrink-0" />
							<span className="truncate">{p.name}</span>
						</div>
					) : (
						<SidebarItem
							key={p.id}
							active={view.kind === "playlist" && view.id === p.id}
							onClick={() => onView({ kind: "playlist", id: p.id })}
							icon={<ListMusic className="size-4" />}
							label={p.name}
							count={p.trackIds.length}
							depth={depth}
						/>
					),
				)}
			</nav>
			<TrackTable tracks={tracks} ordered={playlist !== undefined} />
		</div>
	);
}

function SidebarItem({
	active,
	onClick,
	icon,
	label,
	count,
	depth,
}: {
	active: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	count: number;
	depth: number;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "true" : undefined}
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
				active && "bg-muted font-medium",
			)}
			style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
		>
			<span className="shrink-0 text-muted-foreground">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<span className="shrink-0 text-muted-foreground text-xs tabular-nums">{count}</span>
		</button>
	);
}

function matches(t: UsbTrack, q: string): boolean {
	return [t.title, t.artist, t.album, t.genre].some((f) => f.toLowerCase().includes(q));
}

function TrackTable({ tracks, ordered }: { tracks: readonly UsbTrack[]; ordered: boolean }) {
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	// A playlist can hold the same track twice, so rows are keyed by their place in it.
	const rows = useMemo(() => tracks.map((track, n) => ({ track, slot: n + 1 })), [tracks]);
	const shown = q === "" ? rows : rows.filter((r) => matches(r.track, q));
	return (
		<div className="min-w-0 space-y-3">
			<Input
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Filter by title, artist, album or genre"
				aria-label="Filter tracks"
			/>
			{shown.length === 0 ? (
				<p className="py-10 text-center text-muted-foreground text-sm">
					{tracks.length === 0 ? "No tracks." : "No tracks match."}
				</p>
			) : (
				<table className="w-full table-fixed text-sm">
					<thead className="text-left text-muted-foreground text-xs">
						<tr className="border-b">
							{ordered && <th className="w-8 py-2 font-normal">#</th>}
							<th className="py-2 font-normal">Title</th>
							<th className="w-[30%] py-2 font-normal">Artist</th>
							<th className="w-14 py-2 text-right font-normal">BPM</th>
							<th className="w-12 py-2 text-right font-normal">Key</th>
							<th className="w-12 py-2 text-right font-normal">Time</th>
						</tr>
					</thead>
					<tbody>
						{shown.map(({ track: t, slot }) => (
							<tr key={slot} className="border-b last:border-0" title={t.path}>
								{ordered && <td className="py-1.5 text-muted-foreground tabular-nums">{slot}</td>}
								<td className="truncate py-1.5 pr-3">{t.title || t.path.split("/").pop()}</td>
								<td className="truncate py-1.5 pr-3 text-muted-foreground">{t.artist}</td>
								<td className="py-1.5 text-right tabular-nums">
									{t.tempo > 0 ? formatBpm(t.tempo / 100) : ""}
								</td>
								<td className="py-1.5 text-right">{t.key}</td>
								<td className="py-1.5 text-right text-muted-foreground tabular-nums">
									{clock(t.durationSecs)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
