import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Archive,
	Eject,
	Eraser,
	FolderOpen,
	LibraryBig,
	Settings2,
	TriangleAlert,
	Usb,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { BrandIcon } from "#/components/brand-icon.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { EmptyState } from "#/components/page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { UsbBrowser } from "#/components/usb-browser.tsx";
import { UsbExportButton } from "#/components/usb-export.tsx";
import {
	type UsbDrive,
	type UsbFormats,
	type UsbLibrarySummary,
	usbBackups,
	usbDeleteBackups,
	usbEject,
	usbFormats,
	usbReset,
	usbReveal,
} from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { useUsbDrives, useUsbLibrary } from "#/lib/use-usb.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

/** One plugged-in drive: its space, the rekordbox library on it, and export. */
export function UsbDrivePanel({ mount }: { mount: string }) {
	const drives = useUsbDrives();
	const drive = drives.data?.find((d) => d.mount === mount);
	if (!drive) {
		return drives.isPending ? null : (
			<EmptyState icon={<Usb />} title="Drive unplugged">
				Plug it back in to see its library.
			</EmptyState>
		);
	}
	return <DriveDetail drive={drive} />;
}

type Tab = "contents" | "settings";

function DriveDetail({ drive }: { drive: UsbDrive }) {
	const library = useUsbLibrary(drive.hasLibrary ? drive.mount : null);
	const [tab, setTab] = useState<Tab>("contents");
	// Fills the panel: header and tabs stay put, and what is below scrolls (the browser's two
	// columns each on their own).
	return (
		<div className="flex h-full min-h-0 flex-col gap-5">
			<DriveHeader
				drive={drive}
				actions={<UsbExportButton drive={drive} library={library.data} />}
			/>
			<Tabs tab={tab} onChange={setTab} />
			<div
				className={cn(
					"min-h-0 flex-1",
					(tab === "settings" || !library.data || !drive.hasLibrary) && "overflow-y-auto pb-6",
				)}
			>
				{tab === "contents" ? (
					<>
						{library.isError && <ErrorText message={String(library.error)} />}
						{!drive.hasLibrary && (
							<EmptyState icon={<LibraryBig />} title="No rekordbox library yet">
								Export playlists or tags to create one.
							</EmptyState>
						)}
						{library.isPending && drive.hasLibrary && <EmptyState title="Reading library…" />}
						{library.data && drive.hasLibrary && (
							<UsbBrowser mount={drive.mount} library={library.data} editable={drive.writable} />
						)}
					</>
				) : (
					<DriveSettings drive={drive} />
				)}
			</div>
		</div>
	);
}

/** Thin bar of how full the drive is, beside the numbers it stands for. */
function SpaceBar({ drive }: { drive: UsbDrive }) {
	const used = drive.totalBytes - drive.freeBytes;
	const pct = drive.totalBytes > 0 ? Math.min(100, (used / drive.totalBytes) * 100) : 0;
	return (
		<span className="flex items-center gap-2">
			<span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
				<span
					className={cn("block h-full", pct > 90 ? "bg-warning" : "bg-muted-foreground/60")}
					style={{ width: `${pct}%` }}
				/>
			</span>
			{formatBytes(drive.freeBytes)} free of {formatBytes(drive.totalBytes)}
		</span>
	);
}

function DriveHeader({ drive, actions }: { drive: UsbDrive; actions: ReactNode }) {
	const queryClient = useQueryClient();
	const reveal = useMutation({ mutationFn: () => usbReveal(drive.mount) });
	const eject = useMutation({
		mutationFn: () => usbEject(drive.mount),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["usb-drives"] }),
	});
	return (
		<div className="shrink-0 space-y-4">
			<div className="flex items-start gap-4">
				<BrandIcon brand="usb" className="size-14 rounded-xl" />
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<Usb className="size-3.5" /> CDJ USB
					</div>
					<h2 className={cn("truncate", typeScale.panelTitle)} title={drive.mount}>
						{drive.name}
					</h2>
					<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs tabular-nums">
						<SpaceBar drive={drive} />
						{drive.filesystem && <span>{drive.filesystem.toUpperCase()}</span>}
						{!drive.writable && <span className="text-warning">Read-only</span>}
					</p>
					{(drive.hasLibrary || drive.hasOneLibrary) && <FormatPills mount={drive.mount} />}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				{actions}
				<Button size="sm" variant="outline" onClick={() => reveal.mutate()}>
					<FolderOpen /> Show in Finder
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() => eject.mutate()}
					disabled={eject.isPending}
				>
					<Eject /> {eject.isPending ? "Ejecting…" : "Eject"}
				</Button>
			</div>
			{reveal.isError && <ErrorText message={String(reveal.error)} />}
			{eject.isError && <ErrorText message={String(eject.error)} />}
		</div>
	);
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
	const items: [Tab, string, ReactNode][] = [
		["contents", "Contents", <LibraryBig key="c" />],
		["settings", "Settings", <Settings2 key="s" />],
	];
	return (
		<div role="tablist" className="flex shrink-0 gap-1 border-b">
			{items.map(([id, label, icon]) => (
				<button
					key={id}
					type="button"
					role="tab"
					aria-selected={tab === id}
					onClick={() => onChange(id)}
					className={cn(
						"-mb-px flex items-center gap-2 border-b-2 px-3 py-2 font-medium text-sm transition-colors focus-visible:outline-2 [&_svg]:size-4",
						tab === id
							? "border-primary text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground",
					)}
				>
					{icon}
					{label}
				</button>
			))}
		</div>
	);
}

const FORMATS = [
	{
		key: "deviceLibrary",
		name: "Device Library",
		file: "export.pdb",
		players:
			"CDJ-3000, XDJ-XZ, XDJ-RX3, XDJ-RR, XDJ-1000MK2, XDJ-700, CDJ-900NXS2, CDJ-2000NXS2 and older",
	},
	{
		key: "oneLibrary",
		name: "OneLibrary",
		file: "exportLibrary.db",
		players: "CDJ-3000X, Opus Quad, XDJ-AZ, Omnis Duo",
	},
] as const;

type FormatKey = (typeof FORMATS)[number]["key"];

function summaryText(s: UsbLibrarySummary): string {
	return s.tracks === 0
		? "Empty"
		: `${plural(s.tracks, "track", "tracks")}, ${plural(s.playlists, "playlist", "playlists")}`;
}

/** What to tell the user when the two formats do not cover every player with the same songs. */
function formatsAdvice(f: UsbFormats): string | null {
	const pdb = f.deviceLibrary;
	const one = f.oneLibrary;
	if (pdb && one && pdb.tracks !== one.tracks) {
		return `The two libraries differ (${pdb.tracks.toLocaleString()} and ${one.tracks.toLocaleString()} tracks), so players show different songs. A CDJ-3000 on firmware 3.30 reads the OneLibrary first. Export from manplay to write both from one list.`;
	}
	if (pdb && pdb.tracks > 0 && !one) {
		return "Players that read only OneLibrary show nothing from this drive. Export from manplay to add it.";
	}
	if (one && one.tracks > 0 && !pdb) {
		return "The CDJ-3000 and older players show nothing from this drive. Export from manplay to add a Device Library.";
	}
	return null;
}

type Tone = "ok" | "off" | "warn" | "error";

interface FormatStatus {
	/** Short figure for the pill: "41", "None", "Error". */
	short: string;
	text: string;
	tone: Tone;
	error?: string;
}

function formatStatus(f: UsbFormats | undefined, failed: boolean, key: FormatKey): FormatStatus {
	if (!f) {
		return failed
			? { short: "?", text: "Could not check", tone: "off" }
			: { short: "…", text: "Checking…", tone: "off" };
	}
	const error = f[`${key}Error`];
	if (error) {
		return { short: "Unreadable", text: "Could not be read", tone: "error", error };
	}
	const summary = f[key];
	if (!summary) {
		return { short: "None", text: "Not on this drive", tone: "off" };
	}
	return {
		short: summary.tracks.toLocaleString(),
		text: summaryText(summary),
		tone: summary.tracks > 0 ? "ok" : "off",
	};
}

const DOT: Record<Tone, string> = {
	ok: "bg-success",
	off: "bg-muted-foreground/50",
	warn: "bg-warning",
	error: "bg-destructive",
};

const popup =
	"z-50 w-80 rounded-lg border bg-popover p-3 text-popover-foreground text-sm shadow-lg outline-none";

/** The drive's two library formats as pills; each opens the detail and which players read it. */
function FormatPills({ mount }: { mount: string }) {
	const formats = useQuery({ queryKey: ["usb-formats", mount], queryFn: () => usbFormats(mount) });
	const advice = formats.data ? formatsAdvice(formats.data) : null;
	return (
		<div className="flex flex-wrap gap-1.5 pt-1">
			{FORMATS.map((format) => {
				const status = formatStatus(formats.data, formats.isError, format.key);
				const tone: Tone = advice && status.tone === "ok" ? "warn" : status.tone;
				return (
					<Popover.Root key={format.key}>
						<Popover.Trigger
							className={cn(
								"flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors hover:bg-muted focus-visible:outline-2 data-[popup-open]:bg-muted",
								status.tone === "off" && "text-muted-foreground",
							)}
						>
							<span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[tone])} />
							{format.name}
							<span className="text-muted-foreground tabular-nums">{status.short}</span>
						</Popover.Trigger>
						<Popover.Portal>
							<Popover.Positioner sideOffset={6} align="start" className="z-50">
								<Popover.Popup className={popup}>
									<div className="space-y-2.5">
										<div>
											<Popover.Title className="font-medium">{format.name}</Popover.Title>
											<code className="text-muted-foreground text-xs">{format.file}</code>
										</div>
										<p className={cn(status.tone === "error" && "text-destructive")}>
											{status.text}
										</p>
										{status.error && (
											<p className="break-words text-muted-foreground text-xs">{status.error}</p>
										)}
										<div className="space-y-0.5">
											<p className={typeScale.label}>Read by</p>
											<p className="text-xs">{format.players}</p>
										</div>
										{advice && (
											<p className="flex gap-2 rounded-md bg-warning/10 p-2 text-xs">
												<TriangleAlert className="size-4 shrink-0 text-warning" />
												{advice}
											</p>
										)}
									</div>
								</Popover.Popup>
							</Popover.Positioner>
						</Popover.Portal>
					</Popover.Root>
				);
			})}
		</div>
	);
}

function DriveSettings({ drive }: { drive: UsbDrive }) {
	return (
		<div className="space-y-3">
			{!drive.writable && (
				<p className="flex gap-2 text-muted-foreground text-xs">
					<TriangleAlert className="size-4 shrink-0 text-warning" />
					The drive is read-only, so nothing here can change it.
				</p>
			)}
			<SettingRows>
				<BackupsRow drive={drive} />
				<ResetRow drive={drive} />
			</SettingRows>
		</div>
	);
}

function RowLabel({ icon, title, hint }: { icon: ReactNode; title: string; hint: ReactNode }) {
	return (
		<span className="flex items-start gap-3">
			<span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
			<span className="space-y-0.5">
				<span className="block">{title}</span>
				<span className="block max-w-sm text-muted-foreground text-xs">{hint}</span>
			</span>
		</span>
	);
}

/** The copies of earlier libraries each export keeps, and a way to clear out all but the newest. */
function BackupsRow({ drive }: { drive: UsbDrive }) {
	const queryClient = useQueryClient();
	const key = ["usb-backups", drive.mount];
	const backups = useQuery({ queryKey: key, queryFn: () => usbBackups(drive.mount) });
	const [asking, setAsking] = useState(false);
	const prune = useMutation({
		mutationFn: () => usbDeleteBackups(drive.mount, 1),
		onSuccess: async (left) => {
			setAsking(false);
			queryClient.setQueryData(key, left);
			await queryClient.invalidateQueries({ queryKey: ["usb-drives"] });
		},
	});
	const b = backups.data;
	let hint = "Checking…";
	if (b) {
		hint =
			b.count === 0
				? "None yet. Each export keeps a copy of the library it replaces."
				: `${plural(b.count, "copy", "copies")} of earlier libraries, ${formatBytes(b.bytes)}. The newest is from ${b.latest?.slice(0, 10)}.`;
	}
	const older = (b?.count ?? 0) - 1;
	return (
		<SettingRow label={<RowLabel icon={<Archive />} title="Library backups" hint={hint} />}>
			<Button
				size="sm"
				variant="outline"
				disabled={!drive.writable || older < 1}
				onClick={() => {
					prune.reset();
					setAsking(true);
				}}
			>
				Delete older
			</Button>
			{asking && (
				<ConfirmDialog
					title={`Delete ${plural(older, "older backup", "older backups")}?`}
					confirmLabel={prune.isPending ? "Deleting…" : "Delete"}
					destructive
					busy={prune.isPending}
					onCancel={() => setAsking(false)}
					onConfirm={() => prune.mutate()}
				>
					<p>
						The newest backup stays. The others are deleted from the drive for good, not moved to
						its Trash, so the space frees up now.
					</p>
					{prune.isError && <ErrorText message={String(prune.error)} />}
				</ConfirmDialog>
			)}
			{backups.isError && <ErrorText message={String(backups.error)} />}
		</SettingRow>
	);
}

/**
 * Starts the drive afresh. Everything an export puts there (both libraries, analysis files,
 * artwork, the songs in Contents) goes to the drive's Trash, after typing the drive's name.
 */
function ResetRow({ drive }: { drive: UsbDrive }) {
	const queryClient = useQueryClient();
	const [asking, setAsking] = useState(false);
	const [typed, setTyped] = useState("");
	const field = useId();
	const reset = useMutation({
		mutationFn: () => usbReset(drive.mount),
		onSuccess: async () => {
			setAsking(false);
			setTyped("");
			for (const key of ["usb-drives", "usb-library", "usb-formats", "usb-backups"]) {
				await queryClient.invalidateQueries({ queryKey: [key] });
			}
		},
	});
	const empty = !(drive.hasLibrary || drive.hasOneLibrary);
	return (
		<SettingRow
			label={
				<RowLabel
					icon={<Eraser className="text-destructive" />}
					title="Reset drive"
					hint="Removes the rekordbox library, analysis and exported songs, so the next export starts fresh. Player settings stay."
				/>
			}
		>
			<Button
				size="sm"
				variant="outline"
				className="border-destructive/40 text-destructive hover:bg-destructive/10"
				disabled={!drive.writable || empty}
				onClick={() => {
					reset.reset();
					setAsking(true);
				}}
			>
				Reset drive…
			</Button>
			{asking && (
				<ConfirmDialog
					title={`Reset ${drive.name}?`}
					confirmLabel={reset.isPending ? "Resetting…" : "Reset drive"}
					destructive
					busy={reset.isPending || typed.trim() !== drive.name}
					onCancel={() => {
						setAsking(false);
						setTyped("");
					}}
					onConfirm={() => reset.mutate()}
				>
					<div className="space-y-3">
						<p>
							The rekordbox library (both formats), analysis files, artwork and every song in
							Contents move to the drive&apos;s Trash. Players will show the drive as empty. The
							space frees up when you empty the Trash; until then you can put them back from it.
						</p>
						<div className="space-y-1.5">
							<label htmlFor={field} className="block text-foreground text-xs">
								Type <span className="font-medium">{drive.name}</span> to confirm
							</label>
							<Input
								id={field}
								value={typed}
								autoFocus
								onChange={(e) => setTyped(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && typed.trim() === drive.name && !reset.isPending) {
										reset.mutate();
									}
								}}
							/>
						</div>
						{reset.isError && <ErrorText message={String(reset.error)} />}
					</div>
				</ConfirmDialog>
			)}
		</SettingRow>
	);
}
