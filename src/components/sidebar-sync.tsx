import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import {
	ArrowRight,
	Check,
	CloudUpload,
	Download,
	Eject,
	FolderOpen,
	Loader2,
	RefreshCw,
	Trash2,
	TriangleAlert,
	Upload,
	Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { useRemoveDestination } from "#/components/remove-destination.tsx";
import { AddButton } from "#/components/sidebar-create.tsx";
import { GroupHeading, RowTrailing, SectionLabel } from "#/components/sidebar-parts.tsx";
import {
	CHILD_PAD,
	HOVER_ACTION,
	HOVER_END,
	rowBase,
	rowClass,
	UNDER_HOVER_END,
} from "#/components/sidebar-row.ts";
import { type SyncKind, useSyncActions } from "#/context/sync-actions-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { type ImportFolder, isR2, targetShortName, type UsbDrive, usbEject } from "#/lib/api.ts";
import { compactCount as compact, formatBytes } from "#/lib/format.ts";
import { folderBrand, folderName } from "#/lib/import-folders.ts";
import { useClashes, useSyncScans, useSyncTargets } from "#/lib/queries.ts";
import { type DestinationStatus, destinationStatus } from "#/lib/sync-status.ts";
import { useAddImportFolder, useImportFolders, useImportNewCount } from "#/lib/use-import.ts";
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

/**
 * A source or destination: opens its page. Its state sits at the right end, lined up with every
 * row's count; its hover action (Browse files, Eject) takes that spot while hovered.
 */
function ChildRow({
	brand,
	label,
	title,
	active,
	dim,
	shared,
	trailing,
	hoverAction,
	onOpen,
}: {
	brand: Brand;
	label: string;
	title?: string;
	active: boolean;
	/** Switched off: shown, but quieter. */
	dim?: boolean;
	/** Holds the shared library: a small mark on the icon's corner. */
	shared?: boolean;
	trailing?: ReactNode;
	/** A button shown over the trailing state while the row is hovered. */
	hoverAction?: ReactNode;
	onOpen: () => void;
}) {
	return (
		<div className={cn("group/row relative", rowClass(active))}>
			<button
				type="button"
				title={title ?? label}
				onClick={onOpen}
				className={cn(rowBase, "text-left outline-none", dim && "opacity-60")}
				style={{ paddingLeft: `${CHILD_PAD}px` }}
			>
				<span className="-my-0.5 relative shrink-0">
					<BrandIcon brand={brand} className="size-5 rounded-[5px] ring-0" />
					{shared && <SharedMark />}
				</span>
				<span className="min-w-0 truncate">{label}</span>
				{trailing && (
					<RowTrailing className={cn(hoverAction !== undefined && UNDER_HOVER_END)}>
						{trailing}
					</RowTrailing>
				)}
			</button>
			{hoverAction}
		</div>
	);
}

/** That a destination holds the shared library, as a dot with people on the icon's top-left. */
function SharedMark() {
	return (
		<span
			role="img"
			aria-label="Shared library"
			title="Shared library: tags, playlists and analysis sync through here"
			className="-top-1 -left-1 absolute grid size-3 place-items-center rounded-full bg-primary text-primary-foreground ring-2 ring-canvas"
		>
			<Users className="size-2" strokeWidth={3} />
		</span>
	);
}

/** Browse files on a destination, shown over its state while the row is hovered. */
function BrowseButton({ target, label }: { target: number; label: string }) {
	return (
		<Link
			to="/files"
			search={{ target }}
			aria-label={`Browse files on ${label}`}
			title="Browse files"
			className={cn(iconButton, "size-5", HOVER_END)}
		>
			<FolderOpen />
		</Link>
	);
}

/** Ejects a drive, shown over its free space while the row is hovered; leaves its page once gone. */
function EjectButton({ drive }: { drive: UsbDrive }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const onItsPage = Boolean(matchRoute({ to: "/export/usb", search: { mount: drive.mount } }));
	const eject = useMutation({
		mutationFn: () => usbEject(drive.mount),
		onSuccess: async () => {
			if (onItsPage) {
				await navigate({ to: "/export" });
			}
			await queryClient.invalidateQueries({ queryKey: ["usb-drives"] });
		},
	});
	const failed = eject.isError ? `Could not eject: ${String(eject.error)}` : null;
	return (
		<button
			type="button"
			aria-label={failed ?? `Eject ${drive.name}`}
			title={failed ?? "Eject"}
			disabled={eject.isPending}
			onClick={() => eject.mutate()}
			className={cn(
				iconButton,
				"size-5",
				HOVER_END,
				failed && "text-destructive opacity-100",
				eject.isPending && "opacity-100",
			)}
		>
			{eject.isPending ? (
				<Loader2 className="animate-spin motion-reduce:animate-none" />
			) : (
				<Eject />
			)}
		</button>
	);
}

/** Songs waiting to be imported, as ↓N like a destination's songs to pull. */
function PendingCount({ count, what }: { count: number | null; what: string }) {
	if (count === null || count === 0) {
		return null;
	}
	return (
		<span title={`${count.toLocaleString()} ${what}`} className="text-success">
			↓{compact(count)}
		</span>
	);
}

function ImportItems() {
	const folders = useImportFolders().data ?? [];
	return (
		<>
			{folders.map((f) => (
				<ImportFolderItem key={f.id} folder={f} />
			))}
		</>
	);
}

function ImportFolderItem({ folder }: { folder: ImportFolder }) {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const found = useImportNewCount(folder);
	const params = { folderId: folder.id };
	return (
		<ChildRow
			brand={folderBrand(folder.path)}
			label={folderName(folder.path)}
			title={folder.path}
			active={Boolean(matchRoute({ to: "/import/$folderId", params }))}
			dim={!folder.enabled}
			trailing={folder.enabled ? <PendingCount count={found} what="new songs found" /> : "Off"}
			onOpen={() => void navigate({ to: "/import/$folderId", params })}
		/>
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
				className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
			/>
		);
	}
	if (status.kind === "error") {
		return (
			<span role="img" aria-label={`${SCAN_TEXT.error}: ${status.message}`} title={status.message}>
				<TriangleAlert className="size-3.5 text-destructive" />
			</span>
		);
	}
	if (status.kind === "upToDate") {
		return (
			<span role="img" aria-label={SCAN_TEXT.upToDate} title={SCAN_TEXT.upToDate}>
				<Check className="size-3.5 text-success" />
			</span>
		);
	}
	const parts = [
		status.toPull > 0 && `${status.toPull.toLocaleString()} to pull`,
		status.toPush > 0 && `${status.toPush.toLocaleString()} to push`,
	].filter(Boolean);
	return (
		<span title={parts.join(", ")} className="flex items-center gap-1.5">
			{status.toPull > 0 && <span className="text-success">↓{compact(status.toPull)}</span>}
			{status.toPush > 0 && <span className="text-primary">↑{compact(status.toPush)}</span>}
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
	const { start } = useSyncActions();
	const matchTarget = matchRoute({ to: "/export/$targetId", fuzzy: true });
	// Off its page once it is gone.
	const removal = useRemoveDestination((t) => {
		if (matchTarget && Number(matchTarget.targetId) === t.id) {
			void navigate({ to: "/export" });
		}
	});
	return (
		<>
			{targets.map((t) => {
				const status = destinationStatus(scans, t.id);
				const open = () => void navigate({ to: "/export/$targetId", params: { targetId: t.id } });
				return (
					<RowMenu
						key={t.id}
						label={targetShortName(t)}
						items={[
							{ label: "Open", icon: <ArrowRight />, onSelect: open },
							{
								label: "Browse files",
								icon: <FolderOpen />,
								onSelect: () => void navigate({ to: "/files", search: { target: t.id } }),
							},
							{
								label: "Sync…",
								icon: <RefreshCw />,
								disabled: syncing.size > 0,
								onSelect: () => start("sync", [t.id]),
							},
							"separator",
							{
								label: "Remove destination…",
								icon: <Trash2 />,
								destructive: true,
								disabled: removal.busy,
								onSelect: () => removal.ask(t),
							},
						]}
					>
						<ChildRow
							brand={isR2(t) ? "cloudflare" : "tailscale"}
							label={targetShortName(t)}
							title={`${t.machine}: ${t.path.join(" / ") || "bucket root"}`}
							// The URL holds the id as text; compare it as a number.
							active={matchTarget !== false && Number(matchTarget.targetId) === t.id}
							hoverAction={<BrowseButton target={t.id} label={targetShortName(t)} />}
							shared={t.libsync}
							trailing={
								syncing.has(t.id) ? (
									<span
										role="img"
										aria-label="Syncing"
										className="block size-2 animate-pulse rounded-full bg-primary"
									/>
								) : (
									<ScanIndicator status={status} />
								)
							}
							onOpen={open}
						/>
					</RowMenu>
				);
			})}
			{removal.dialog}
			{rekordbox?.path && (
				<ChildRow
					brand="rekordbox"
					label="rekordbox XML"
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
					hoverAction={<EjectButton drive={d} />}
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
			<Link to="/settings" className={cn(rowBase, "text-left outline-none")}>
				<TriangleAlert className="size-4 shrink-0 text-warning" />
				<span className="truncate">Clashes</span>
				<RowTrailing>
					<span className="text-warning">{compact(count)}</span>
				</RowTrailing>
			</Link>
		</div>
	);
}

/**
 * Import and Export with their sources and destinations folded under them, and pull, push and
 * sync on the heading. Choosing a source or destination opens its page.
 */
export function SidebarSync() {
	const navigate = useNavigate();
	const addFolder = useAddImportFolder();
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
				action={
					<AddButton
						label="Add import folder"
						onClick={() =>
							addFolder.mutate(undefined, {
								onSuccess: (f) =>
									f && void navigate({ to: "/import/$folderId", params: { folderId: f.id } }),
							})
						}
						className={HOVER_ACTION}
					/>
				}
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
