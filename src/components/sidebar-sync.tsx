import { Link } from "@tanstack/react-router";
import { CloudUpload, Download, FolderOpen, RefreshCw, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { useDownloadsEnabled } from "#/components/downloads-source.tsx";
import { useItunesOn } from "#/components/itunes-source.tsx";
import { AddButton } from "#/components/sidebar-create.tsx";
import { GroupHeading, SectionLabel } from "#/components/sidebar-parts.tsx";
import { CHILD_INDENT, HOVER_ACTION, rowBase, rowClass } from "#/components/sidebar-row.ts";
import { type DetailView, useDetail } from "#/context/detail-context.ts";
import { type SyncKind, useSyncActions } from "#/context/sync-actions-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { isR2 } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { useSyncTargets } from "#/lib/queries.ts";
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

/** A source or destination: opens in the side panel without leaving the page you are on. */
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

const isView = (view: DetailView | null, match: DetailView) =>
	view !== null && JSON.stringify(view) === JSON.stringify(match);

function ImportItems() {
	const detail = useDetail();
	const downloads = useDownloadsEnabled().enabled;
	const itunes = useItunesOn();
	const rows: { service: "downloads" | "itunes"; brand: Brand; label: string; on: boolean }[] = [
		{ service: "downloads", brand: "downloads", label: "Downloads", on: downloads },
		{ service: "itunes", brand: "itunes", label: "iTunes", on: itunes },
	];
	return (
		<>
			{rows.map((r) => {
				const view: DetailView = { kind: "service", service: r.service };
				return (
					<ChildRow
						key={r.service}
						brand={r.brand}
						label={r.label}
						active={isView(detail.view, view)}
						dim={!r.on}
						trailing={r.on ? undefined : "Off"}
						onOpen={() => detail.open(view)}
					/>
				);
			})}
		</>
	);
}

function ExportItems() {
	const detail = useDetail();
	const targets = useSyncTargets().data ?? [];
	const drives = useUsbDrives().data ?? [];
	const rekordbox = useRekordbox().status.data;
	const progress = useSyncProgress();
	const syncing = new Set([...progress.values()].map((p) => p.targetId));
	return (
		<>
			{targets.map((t) => {
				const view: DetailView = { kind: "target", id: t.id };
				return (
					<ChildRow
						key={t.id}
						brand={isR2(t) ? "cloudflare" : "tailscale"}
						label={t.machine}
						title={`${t.machine}: ${t.path.join(" / ") || "bucket root"}`}
						active={isView(detail.view, view)}
						browse={t.id}
						trailing={
							syncing.has(t.id) && (
								<span
									role="img"
									aria-label="Syncing"
									className="block size-2 animate-pulse rounded-full bg-primary"
								/>
							)
						}
						onOpen={() => detail.open(view)}
					/>
				);
			})}
			{rekordbox?.path && (
				<ChildRow
					brand="rekordbox"
					label="Rekordbox XML"
					title={rekordbox.path}
					active={isView(detail.view, { kind: "service", service: "rekordbox" })}
					onOpen={() => detail.open({ kind: "service", service: "rekordbox" })}
				/>
			)}
			{drives.map((d) => (
				<ChildRow
					key={d.mount}
					brand="usb"
					label={d.name}
					title={`${d.name}, ${formatBytes(d.freeBytes)} free`}
					active={isView(detail.view, { kind: "usb", mount: d.mount })}
					trailing={formatBytes(d.freeBytes)}
					onOpen={() => detail.open({ kind: "usb", mount: d.mount })}
				/>
			))}
		</>
	);
}

/**
 * Import and Export with their sources and destinations folded under them, and pull, push and
 * sync on the heading. Choosing a source or destination opens it in the side panel.
 */
export function SidebarSync() {
	const detail = useDetail();
	const [importClosed, setImportClosed] = useStoredFlag("manplay.sidebar.importClosed");
	const [exportClosed, setExportClosed] = useStoredFlag("manplay.sidebar.exportClosed");
	return (
		<section className="space-y-0.5">
			<SectionLabel action={<QuickActions />}>Sync</SectionLabel>
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
						onClick={() => detail.open({ kind: "add-destination" })}
						className={HOVER_ACTION}
					/>
				}
			/>
			{!exportClosed && <ExportItems />}
		</section>
	);
}
