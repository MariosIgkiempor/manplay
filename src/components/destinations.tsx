import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderOpen, PanelRightOpen, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { type MenuEntry, RowMenu } from "#/components/menu.tsx";
import { EmptyState, ErrorLine, Section } from "#/components/page.tsx";
import { RekordboxExportButton } from "#/components/rekordbox-view.tsx";
import { LibraryBadge } from "#/components/shared-library.tsx";
import { SyncButton } from "#/components/sync-flow.tsx";
import { Button } from "#/components/ui/button.tsx";
import { type DetailView, useDetail } from "#/context/detail-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import {
	isR2,
	removeSyncTarget,
	type SyncTarget,
	tailscaleStatus,
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

/** Icon, name and where; a bar for how full it is; what happened last; one action. */
const GRID = "grid-cols-[2rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto_1rem]";

/** How much of something a destination holds: the library for a sync, space for a drive. */
function Fill({ value, total, label }: { value: number; total: number; label: string }) {
	const percent = total === 0 ? 0 : Math.min(100, (value / total) * 100);
	return (
		<div className="min-w-0 space-y-1.5">
			<div className="truncate text-muted-foreground text-xs tabular-nums">{label}</div>
			{/* The label above says the same in words. */}
			<div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted">
				<div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
			</div>
		</div>
	);
}

interface RowProps {
	brand: Brand;
	name: string;
	/** Next to the name, e.g. what kind of destination it is. */
	badge?: ReactNode;
	where: ReactNode;
	/** Hover text for `where`, e.g. the full path. */
	whereTitle?: string;
	fill: ReactNode;
	status: ReactNode;
	action: ReactNode;
	open: DetailView;
	menu: readonly MenuEntry[];
}

/** One destination. The row opens its details; the action works without opening it. */
function Row({
	brand,
	name,
	badge,
	where,
	whereTitle,
	fill,
	status,
	action,
	open,
	menu,
}: RowProps) {
	const detail = useDetail();
	const go = () => detail.open(open);
	return (
		<RowMenu
			label={name}
			items={[{ label: "Open", icon: <PanelRightOpen />, onSelect: go }, "separator", ...menu]}
		>
			<div
				className={cn(
					"group grid min-h-16 items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40",
					GRID,
				)}
			>
				<BrandIcon brand={brand} className="size-8" />
				<button
					type="button"
					onClick={go}
					className="min-w-0 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					<span className="flex items-center gap-2">
						<span className="truncate font-medium text-sm">{name}</span>
						{badge}
					</span>
					<span className="block truncate text-muted-foreground text-xs" title={whereTitle}>
						{where}
					</span>
				</button>
				{fill}
				<div className="min-w-0 truncate text-muted-foreground text-xs">{status}</div>
				{/* Right-clicks on the action are its own, not the row's. */}
				<fieldset
					aria-label={`${name} actions`}
					className="flex min-w-0 justify-end"
					onContextMenu={(e) => e.stopPropagation()}
				>
					{action}
				</fieldset>
				<button
					type="button"
					aria-label={`Open ${name}`}
					onClick={go}
					className="text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
				>
					<ChevronRight className="size-4" />
				</button>
			</div>
		</RowMenu>
	);
}

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
		<Row
			brand={r2 ? "cloudflare" : "tailscale"}
			name={target.machine}
			badge={<LibraryBadge target={target} />}
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
					{target.path.join(" / ") || "Bucket root"}
				</span>
			}
			fill={
				<Fill
					value={target.syncedTracks}
					total={librarySize}
					label={`${target.syncedTracks.toLocaleString()} of ${plural(librarySize, "song", "songs")}`}
				/>
			}
			status={status}
			action={
				<SyncButton size="sm" variant="outline" ids={[target.id]} disabled={progress.size > 0} />
			}
			open={{ kind: "target", id: target.id }}
			menu={[{ label: "Remove…", icon: <Trash2 />, destructive: true, onSelect: onRemove }]}
		/>
	);
}

function RekordboxRow() {
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
		<Row
			brand="rekordbox"
			name="Rekordbox XML"
			where={baseName(s.path)}
			whereTitle={s.path}
			fill={
				<div className="text-muted-foreground text-xs tabular-nums">
					{plural(s.playlists, "playlist", "playlists")}, {plural(s.tracks, "song", "songs")}
				</div>
			}
			status={line}
			action={<RekordboxExportButton size="sm" variant="outline" />}
			open={{ kind: "service", service: "rekordbox" }}
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
	const detail = useDetail();
	const used = drive.totalBytes - drive.freeBytes;
	return (
		<Row
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
				<Fill
					value={used}
					total={drive.totalBytes}
					label={`${formatBytes(drive.freeBytes)} free`}
				/>
			}
			status="Plugged in"
			action={
				<Button
					size="sm"
					variant="outline"
					onClick={() => detail.open({ kind: "usb", mount: drive.mount })}
				>
					Browse
				</Button>
			}
			open={{ kind: "usb", mount: drive.mount }}
			menu={[]}
		/>
	);
}

/** Every export destination in one list: sync folders, the rekordbox file, plugged-in drives. */
export function Destinations() {
	const queryClient = useQueryClient();
	const detail = useDetail();
	const targets = useSyncTargets();
	const tracks = useTracks();
	const drives = useUsbDrives();
	const rekordbox = useRekordbox().status.data;
	const [removing, setRemoving] = useState<SyncTarget | null>(null);
	const remove = useMutation({
		mutationFn: removeSyncTarget,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
		},
	});
	const list = targets.data ?? [];
	const plugged = drives.data ?? [];
	const count = list.length + plugged.length + (rekordbox?.path ? 1 : 0);
	const librarySize = tracks.data?.length ?? 0;
	const add = () => detail.open({ kind: "add-destination" });

	return (
		<Section
			title="Destinations"
			count={count}
			action={
				<Button size="sm" onClick={add}>
					<Plus /> Add destination
				</Button>
			}
		>
			{remove.isError && <ErrorLine>{String(remove.error)}</ErrorLine>}
			{count === 0 ? (
				<div className="rounded-lg border border-dashed">
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
				<div className="divide-y overflow-hidden rounded-lg border bg-card">
					{list.map((t) => (
						<TargetRow
							key={t.id}
							target={t}
							librarySize={librarySize}
							onRemove={() => setRemoving(t)}
						/>
					))}
					<RekordboxRow />
					{plugged.map((d) => (
						<UsbRow key={d.mount} drive={d} />
					))}
				</div>
			)}
			{removing && (
				<ConfirmDialog
					title={`Remove ${removing.machine}?`}
					confirmLabel="Remove destination"
					destructive
					busy={remove.isPending}
					onCancel={() => setRemoving(null)}
					onConfirm={() => {
						remove.mutate(removing.id);
						setRemoving(null);
					}}
				>
					manplay stops syncing there. Files already in {removing.path.join(" / ") || "the bucket"}{" "}
					stay.
				</ConfirmDialog>
			)}
		</Section>
	);
}
