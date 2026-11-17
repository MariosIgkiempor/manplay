import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import {
	Check,
	CloudUpload,
	Download,
	FolderOpen,
	Loader2,
	RefreshCw,
	TriangleAlert,
	Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { useDownloadsEnabled } from "#/components/downloads-source.tsx";
import { useItunesOn } from "#/components/itunes-source.tsx";
import { AddButton } from "#/components/sidebar-create.tsx";
import { GroupHeading, SectionLabel } from "#/components/sidebar-parts.tsx";
import { CHILD_INDENT, HOVER_ACTION, rowBase, rowClass } from "#/components/sidebar-row.ts";
import { type SyncKind, useSyncActions } from "#/context/sync-actions-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { isR2 } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { useClashes, useItunesPending, useSyncScans, useSyncTargets } from "#/lib/queries.ts";
import { type DestinationStatus, destinationStatus } from "#/lib/sync-status.ts";
import { useDownloadsNewCount } from "#/lib/use-import.ts";
import { useStoredFlag } from "#/lib/use-pane-width.ts";
import { useRekordbox } from "#/lib/use-rekordbox.ts";
import { useUsbDrives } from "#/lib/use-usb.ts";
import { cn } from "#/lib/utils.ts";

const iconButton =
	"grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5";

const ACTIONS: { kind: SyncKind; label: string; icon: ReactNode }[] = [
	{ kind: "pull", label: "Review pull", icon: <Download /> },
	{ kind: "push", label: "Review push", icon: <CloudUpload /> },
	{ kind: "sync", label: "Sync", icon: <RefreshCw /> },
];

/** Pull, push and sync, one click from anywhere; each opens its review before changing anything. */
function QuickActions() {
	const { start } = useSyncActions();
	const busy = useSyncProgress().size > 0;
	const none = (useSyncTargets().data ?? []).length === 0;
	return (
		<div className="flex items-center gap-0.5">
			{ACTIONS.map((a) => (
				<button
					key={a.kind}
					type="button"
					aria-label={a.label}
					title={none ? `${a.label} (add a destination first)` : a.label}
					disabled={busy || none}
					onClick={() => start(a.kind)}
					className={iconButton}
				>
					{a.icon}
				</button>
			))}
		</div>
	);
}

/** A source or destination: opens its page. */
function ChildRow({
	brand,
	label,
	title,
	active,
	dim,
	trailing,
	browse,
	onOpen,
}: {
	brand: Brand;
	label: string;
	title?: string;
	active: boolean;
	/** Switched off: shown, but quieter. */
	dim?: boolean;
	trailing?: ReactNode;
	/** Destination id whose files can be browsed; adds a hover button next to the row. */
	browse?: number;
	onOpen: () => void;
}) {
	return (
		<div className={cn("group/row", rowClass(active))}>
			<button
				type="button"
				title={title ?? label}
				onClick={onOpen}
				className={cn(rowBase, "text-left outline-none", dim && "opacity-60")}
				style={{ paddingLeft: `${8 + CHILD_INDENT}px` }}
			>
				<BrandIcon brand={brand} className="size-4 rounded-[4px] ring-0" />
				<span className="truncate">{label}</span>
				{trailing && <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums">{trailing}</span>}
			</button>
			{browse === undefined ? (
				<span className="size-5 shrink-0" />
			) : (
				<Link
					to="/files"
					search={{ target: browse }}
					aria-label={`Browse files on ${label}`}
					title="Browse files"
					className={cn(
						iconButton,
						"size-5 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100",
					)}
				>
					<FolderOpen />
				</Link>
			)}
		</div>
	);
}

/** Songs waiting to be imported, as a count after the source's name. */
function PendingCount({ count, what }: { count: number | null; what: string }) {
	if (count === null || count === 0) {
		return null;
	}
	return (
		<span
			title={`${count.toLocaleString()} ${what}`}
			className="rounded-full bg-primary/15 px-1.5 py-px font-medium text-[10px] text-primary leading-4"
		>
			{count.toLocaleString()}
		</span>
	);
}

function ImportItems() {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const downloads = useDownloadsEnabled().enabled;
	const downloadsNew = useDownloadsNewCount(downloads);
	const itunes = useItunesOn();
	const itunesPending = useItunesPending(itunes).data?.length ?? null;
	const rows = [
		{
			to: "/import/downloads",
			brand: "downloads",
			label: "Downloads",
			on: downloads,
			pending: <PendingCount count={downloadsNew} what="new songs found" />,
		},
		{
			to: "/import/itunes",
			brand: "itunes",
			label: "iTunes",
			on: itunes,
			pending: <PendingCount count={itunesPending} what="songs not imported yet" />,
		},
	] as const satisfies readonly {
		to: "/import/downloads" | "/import/itunes";
		brand: Brand;
		label: string;
		on: boolean;
		pending: ReactNode;
	}[];
	return (
		<>
			{rows.map((r) => (
				<ChildRow
					key={r.to}
					brand={r.brand}
					label={r.label}
					active={Boolean(matchRoute({ to: r.to }))}
					dim={!r.on}
					trailing={r.on ? r.pending : "Off"}
					onOpen={() => void navigate({ to: r.to })}
				/>
			))}
		</>
	);
}

const SCAN_TEXT: Record<DestinationStatus["kind"], string> = {
	scanning: "Reading the destination…",
	waiting: "Waiting to be read",
	error: "Could not be read",
	upToDate: "Up to date",
	changes: "Changes to sync",
};

/** How the destination compares with the library, from its last background read. */
function ScanIndicator({ status }: { status: DestinationStatus | null }) {
	if (status === null || status.kind === "waiting") {
		return null;
	}
	if (status.kind === "scanning") {
		return (
			<Loader2
				role="img"
				aria-label={SCAN_TEXT.scanning}
				className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none"
			/>
		);
	}
	if (status.kind === "error") {
		return (
			<span role="img" aria-label={`${SCAN_TEXT.error}: ${status.message}`} title={status.message}>
				<TriangleAlert className="size-3 text-destructive" />
			</span>
		);
	}
	if (status.kind === "upToDate") {
		return (
			<span role="img" aria-label={SCAN_TEXT.upToDate} title={SCAN_TEXT.upToDate}>
				<Check className="size-3 text-success" />
			</span>
		);
	}
	const parts = [
		status.toPull > 0 && `${status.toPull.toLocaleString()} to pull`,
		status.toPush > 0 && `${status.toPush.toLocaleString()} to push`,
	].filter(Boolean);
	return (
		<span title={parts.join(", ")} className="flex items-center gap-1 text-[11px] tabular-nums">
			{status.toPull > 0 && <span className="text-success">↓{status.toPull.toLocaleString()}</span>}
			{status.toPush > 0 && <span className="text-primary">↑{status.toPush.toLocaleString()}</span>}
		</span>
	);
}

function ExportItems() {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const scans = useSyncScans().data;
	const targets = useSyncTargets().data ?? [];
	const drives = useUsbDrives().data ?? [];
	const rekordbox = useRekordbox().status.data;
	const progress = useSyncProgress();
	const syncing = new Set([...progress.values()].map((p) => p.targetId));
	return (
		<>
			{targets.map((t) => {
				const status = destinationStatus(scans, t.id);
				return (
					<ChildRow
						key={t.id}
						brand={isR2(t) ? "cloudflare" : "tailscale"}
						label={t.machine}
						title={`${t.machine}: ${t.path.join(" / ") || "bucket root"}`}
						active={Boolean(matchRoute({ to: "/export/$targetId", params: { targetId: t.id } }))}
						browse={t.id}
						trailing={
							(t.libsync || syncing.has(t.id) || status !== null) && (
								<span className="flex items-center gap-1.5">
									{t.libsync && (
										<span
											title="Holds your shared library"
											className="rounded-full bg-primary/15 px-1.5 py-px font-medium text-[10px] text-primary leading-4"
										>
											Shared
										</span>
									)}
									{syncing.has(t.id) ? (
										<span
											role="img"
											aria-label="Syncing"
											className="block size-2 animate-pulse rounded-full bg-primary"
										/>
									) : (
										<ScanIndicator status={status} />
									)}
								</span>
							)
						}
						onOpen={() => void navigate({ to: "/export/$targetId", params: { targetId: t.id } })}
					/>
				);
			})}
			{rekordbox?.path && (
				<ChildRow
					brand="rekordbox"
					label="Rekordbox XML"
					title={rekordbox.path}
					active={Boolean(matchRoute({ to: "/export/rekordbox" }))}
					onOpen={() => void navigate({ to: "/export/rekordbox" })}
				/>
			)}
			{drives.map((d) => (
				<ChildRow
					key={d.mount}
					brand="usb"
					label={d.name}
					title={`${d.name}, ${formatBytes(d.freeBytes)} free`}
					active={Boolean(matchRoute({ to: "/export/usb", search: { mount: d.mount } }))}
					trailing={formatBytes(d.freeBytes)}
					onOpen={() => void navigate({ to: "/export/usb", search: { mount: d.mount } })}
				/>
			))}
		</>
	);
}

/** Items with the same name on two sides, with their count; opens them in Settings. */
function ClashesRow() {
	const count = useClashes().data?.length ?? 0;
	const inLibrary = useSyncTargets().data?.some((t) => t.libsync) ?? false;
	if (!inLibrary || count === 0) {
		return null;
	}
	return (
		<div className={rowClass(false)}>
			<Link
				to="/settings"
				className={cn(rowBase, "text-left outline-none")}
				style={{ paddingLeft: "8px" }}
			>
				<TriangleAlert className="size-4 shrink-0 text-warning" />
				<span className="truncate">Clashes</span>
				<span className="ml-auto rounded-full bg-warning/15 px-1.5 text-warning text-xs tabular-nums">
					{count}
				</span>
			</Link>
			<span className="size-5 shrink-0" />
		</div>
	);
}

/**
 * Import and Export with their sources and destinations folded under them, and pull, push and
 * sync on the heading. Choosing a source or destination opens its page.
 */
export function SidebarSync() {
	const navigate = useNavigate();
	const [importClosed, setImportClosed] = useStoredFlag("manplay.sidebar.importClosed");
	const [exportClosed, setExportClosed] = useStoredFlag("manplay.sidebar.exportClosed");
	return (
		<section className="space-y-0.5">
			<SectionLabel action={<QuickActions />}>Sync</SectionLabel>
			<ClashesRow />
			<GroupHeading
				to="/import"
				label="Import"
				icon={<Download />}
				open={!importClosed}
				onToggle={() => setImportClosed(!importClosed)}
			/>
			{!importClosed && <ImportItems />}
			<GroupHeading
				to="/export"
				label="Export"
				icon={<Upload />}
				open={!exportClosed}
				onToggle={() => setExportClosed(!exportClosed)}
				action={
					<AddButton
						label="Add destination"
						onClick={() => void navigate({ to: "/export/add", search: {} })}
						className={HOVER_ACTION}
					/>
				}
			/>
			{!exportClosed && <ExportItems />}
		</section>
	);
}
