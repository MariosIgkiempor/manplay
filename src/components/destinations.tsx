import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { FrameSection } from "#/components/frame.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { PlaceFill, PlaceRow } from "#/components/place-row.tsx";
import { RekordboxExportButton } from "#/components/rekordbox-view.tsx";
import { useRemoveDestination } from "#/components/remove-destination.tsx";
import { LibraryBadge } from "#/components/shared-library.tsx";
import { SyncButton } from "#/components/sync-flow.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import {
	isR2,
	type SyncTarget,
	tailscaleStatus,
	targetShortName,
	type UsbDrive,
} from "#/lib/api.ts";
import { formatBytes, timeAgo } from "#/lib/format.ts";
import { baseName } from "#/lib/fs-path.ts";
import { useSyncHistory, useSyncTargets, useTracks } from "#/lib/queries.ts";
import { useRekordbox } from "#/lib/use-rekordbox.ts";
import { useUsbDrives } from "#/lib/use-usb.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

function useOnline(target: SyncTarget): boolean | undefined {
	const machines = useQuery({
		queryKey: ["ts-status"],
		queryFn: tailscaleStatus,
		enabled: !isR2(target),
	});
	return machines.data?.machines.find((m) => m.name === target.machine)?.online;
}

function TargetRow({
	target,
	librarySize,
	onRemove,
}: {
	target: SyncTarget;
	librarySize: number;
	onRemove: () => void;
}) {
	const navigate = useNavigate();
	const progress = useSyncProgress();
	const history = useSyncHistory();
	const online = useOnline(target);
	const live = [...progress.values()].find((p) => p.targetId === target.id);
	const last = history.data?.find((r) => r.targetId === target.id);
	const r2 = isR2(target);
	let status: ReactNode = "Never synced";
	if (live) {
		status = (
			<span className="text-foreground">
				Syncing {live.done} of {live.total}
			</span>
		);
	} else if (last) {
		status = `Synced ${timeAgo(last.finishedAt)}`;
	}
	return (
		<PlaceRow
			brand={r2 ? "cloudflare" : "tailscale"}
			name={targetShortName(target)}
			badge={<LibraryBadge target={target} />}
			whereTitle={`${target.machine}: ${target.path.join(" / ") || "bucket root"}`}
			where={
				<span className="inline-flex items-center gap-1.5">
					{!r2 && (
						<span
							role="img"
							aria-label={online ? "Online" : "Offline"}
							title={online ? "Online" : "Offline"}
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								online ? "bg-success" : "bg-muted-foreground/60",
							)}
						/>
					)}
					{r2 ? target.path.join(" / ") || "Bucket root" : target.machine}
				</span>
			}
			fill={
				<PlaceFill
					value={target.syncedTracks}
					total={librarySize}
					label={`${target.syncedTracks.toLocaleString()} of ${plural(librarySize, "song", "songs")}`}
				/>
			}
			status={status}
			action={
				<SyncButton size="sm" variant="outline" ids={[target.id]} disabled={progress.size > 0} />
			}
			open={() => void navigate({ to: "/export/$targetId", params: { targetId: target.id } })}
			menu={[{ label: "Remove…", icon: <Trash2 />, destructive: true, onSelect: onRemove }]}
		/>
	);
}

function RekordboxRow() {
	const navigate = useNavigate();
	const { status, choose, stop } = useRekordbox();
	const s = status.data;
	if (!s?.path) {
		return null;
	}
	let line: ReactNode =
		s.exportedAt === null ? "Not exported yet" : `Exported ${timeAgo(s.exportedAt)}`;
	if (s.error) {
		line = <span className="text-destructive">{s.error}</span>;
	}
	return (
		<PlaceRow
			brand="rekordbox"
			name="rekordbox XML"
			where={baseName(s.path)}
			whereTitle={s.path}
			fill={
				<div className="text-muted-foreground text-xs tabular-nums">
					{plural(s.playlists, "playlist", "playlists")}, {plural(s.tracks, "song", "songs")}
				</div>
			}
			status={line}
			action={<RekordboxExportButton size="sm" variant="outline" />}
			open={() => void navigate({ to: "/export/rekordbox" })}
			menu={[
				{ label: "Change location…", icon: <FolderOpen />, onSelect: () => choose.mutate() },
				{
					label: "Remove",
					icon: <Trash2 />,
					destructive: true,
					onSelect: () => stop.mutate(),
				},
			]}
		/>
	);
}

function UsbRow({ drive }: { drive: UsbDrive }) {
	const navigate = useNavigate();
	const open = () => void navigate({ to: "/export/usb", search: { mount: drive.mount } });
	const used = drive.totalBytes - drive.freeBytes;
	return (
		<PlaceRow
			brand="usb"
			name={drive.name}
			where={[
				"CDJ USB",
				drive.filesystem.toUpperCase(),
				drive.hasLibrary ? "" : "no rekordbox library yet",
				drive.writable ? "" : "read-only",
			]
				.filter(Boolean)
				.join(", ")}
			fill={
				<PlaceFill
					value={used}
					total={drive.totalBytes}
					label={`${formatBytes(drive.freeBytes)} free`}
				/>
			}
			status="Plugged in"
			action={
				<Button size="sm" variant="outline" onClick={open}>
					Browse
				</Button>
			}
			open={open}
			menu={[]}
		/>
	);
}

/** Every export destination in one list: sync folders, the rekordbox file, plugged-in drives. */
export function Destinations() {
	const navigate = useNavigate();
	const targets = useSyncTargets();
	const tracks = useTracks();
	const drives = useUsbDrives();
	const rekordbox = useRekordbox().status.data;
	const removal = useRemoveDestination();
	const list = targets.data ?? [];
	const plugged = drives.data ?? [];
	const count = list.length + plugged.length + (rekordbox?.path ? 1 : 0);
	const librarySize = tracks.data?.length ?? 0;
	const add = () => void navigate({ to: "/export/add", search: {} });

	return (
		<FrameSection
			title="Destinations"
			count={count}
			action={
				// With no destinations the empty state below carries the button.
				count > 0 && (
					<Button size="sm" variant="outline" onClick={add}>
						<Plus /> Add destination
					</Button>
				)
			}
		>
			{removal.error && (
				<div className="px-4 py-3">
					<ErrorLine>{String(removal.error)}</ErrorLine>
				</div>
			)}
			{count === 0 ? (
				<div>
					<EmptyState
						title="No destinations yet"
						action={
							<Button onClick={add}>
								<Plus /> Add destination
							</Button>
						}
					>
						Back up to a Tailscale folder or an R2 bucket, write a rekordbox file, or plug in a CDJ
						USB drive.
					</EmptyState>
				</div>
			) : (
				<div className="divide-y divide-hairline">
					{list.map((t) => (
						<TargetRow
							key={t.id}
							target={t}
							librarySize={librarySize}
							onRemove={() => removal.ask(t)}
						/>
					))}
					<RekordboxRow />
					{plugged.map((d) => (
						<UsbRow key={d.mount} drive={d} />
					))}
				</div>
			)}
			{removal.dialog}
		</FrameSection>
	);
}
