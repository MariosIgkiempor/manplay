import { Popover } from "@base-ui/react/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Archive,
	Eject,
	Eraser,
	FolderOpen,
	FolderTree,
	LibraryBig,
	Settings2,
	TriangleAlert,
	Usb,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { BrandGlyph } from "#/components/brand-icon.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { DestinationHeader, SettingLabel, UsageBar } from "#/components/destination-header.tsx";
import { HeaderMenu } from "#/components/header-menu.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { PlaceFrame } from "#/components/place-page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { UsbBrowser } from "#/components/usb-browser.tsx";
import { UsbExportButton } from "#/components/usb-export.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
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
import { FILE_MANAGER, isMac } from "#/lib/platform.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { useUsbDrives, useUsbLibrary } from "#/lib/use-usb.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

/** One plugged-in drive: its space, the rekordbox library on it, and export. */
export function UsbDrivePage({ mount }: { mount: string }) {
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
	// Fills the page: header and tabs stay put, and what is below scrolls (the browser's two
	// columns each on their own).
	const browsing = tab === "contents" && library.data !== undefined && drive.hasLibrary;
	return (
		<PlaceFrame
			fill={browsing}
			header={
				<DriveHeader
					drive={drive}
					actions={<UsbExportButton drive={drive} library={library.data} />}
					tabs={
						<Segmented
							className="border-b-0"
							value={tab}
							onChange={setTab}
							label="Drive view"
							items={[
								{ value: "contents", label: "Contents", icon: <LibraryBig /> },
								{ value: "settings", label: "Settings", icon: <Settings2 /> },
							]}
						/>
					}
				/>
			}
		>
			<div className={cn(browsing && "h-full px-6 pt-5")}>
				{tab === "contents" ? (
					<>
						{library.isError && <ErrorLine>{String(library.error)}</ErrorLine>}
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
		</PlaceFrame>
	);
}

function SpaceBar({ drive }: { drive: UsbDrive }) {
	return (
		<UsageBar value={drive.totalBytes - drive.freeBytes} total={drive.totalBytes} warnAbove={0.9}>
			{formatBytes(drive.freeBytes)} free of {formatBytes(drive.totalBytes)}
		</UsageBar>
	);
}

function DriveHeader({
	drive,
	actions,
	tabs,
}: {
	drive: UsbDrive;
	actions: ReactNode;
	tabs: ReactNode;
}) {
	const queryClient = useQueryClient();
	const reveal = useMutation({ mutationFn: () => usbReveal(drive.mount) });
	const eject = useMutation({
		mutationFn: () => usbEject(drive.mount),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["usb-drives"] }),
	});
	return (
		<div className="shrink-0 space-y-2">
			<DestinationHeader
				section="export"
				place={`usb:${drive.mount}`}
				brand="usb"
				kind={
					<>
						<Usb /> CDJ USB
					</>
				}
				title={drive.name}
				titleHint={[drive.mount, drive.filesystem?.toUpperCase()].filter(Boolean).join(" · ")}
				meta={
					<>
						<SpaceBar drive={drive} />
						{!drive.writable && <span className="text-warning">Read-only</span>}
					</>
				}
				extra={(drive.hasLibrary || drive.hasOneLibrary) && <FormatPills mount={drive.mount} />}
				actions={
					<>
						{actions}
						<HeaderMenu
							size="sm"
							entries={[
								{
									label: `Show in ${FILE_MANAGER}`,
									icon: <FolderOpen />,
									onSelect: () => reveal.mutate(),
								},
								{
									label: eject.isPending ? "Ejecting…" : "Eject",
									icon: <Eject />,
									onSelect: () => eject.mutate(),
									disabled: eject.isPending,
								},
							]}
						/>
					</>
				}
				tabs={tabs}
			/>
			{reveal.isError && <ErrorLine>{String(reveal.error)}</ErrorLine>}
			{eject.isError && <ErrorLine>{String(eject.error)}</ErrorLine>}
		</div>
	);
}

const FORMATS = [
	{
		key: "deviceLibrary",
		brand: "rekordbox",
		name: "Device Library",
		file: "export.pdb",
		players:
			"CDJ-3000, XDJ-XZ, XDJ-RX3, XDJ-RR, XDJ-1000MK2, XDJ-700, CDJ-900NXS2, CDJ-2000NXS2 and older",
	},
	{
		key: "oneLibrary",
		brand: "rekordbox",
		name: "OneLibrary",
		file: "exportLibrary.db",
		players: "CDJ-3000X, Opus Quad, XDJ-AZ, Omnis Duo",
	},
	{
		key: "serato",
		brand: "serato",
		name: "Serato",
		file: "_Serato_/database V2",
		players: "Serato DJ, on a computer or a controller it drives",
		holds: ["song", "crate"],
	},
	{
		key: "virtualDj",
		brand: "virtualdj",
		name: "VirtualDJ",
		file: "VirtualDJ/database.xml",
		players: "VirtualDJ, on a computer or a controller it drives",
		holds: ["song", "list"],
	},
	{
		key: "gemini",
		brand: "gemini",
		name: "Gemini",
		file: "GEMINI/gemini_bd.sqlite",
		players: "Gemini MDJ-500, MDJ-600, MDJ-900, MDJ-1000 (MP3 and WAV only)",
	},
	{
		key: "playlistFolders",
		brand: null,
		name: "Folders",
		file: "Playlists/",
		players: "Any player that browses folders, such as the MDJ-500",
		holds: ["song", "folder"],
	},
] as const satisfies readonly {
	key: string;
	/** The software that reads it, whose mark stands for it; none for plain folders. */
	brand: "rekordbox" | "serato" | "virtualdj" | "gemini" | null;
	name: string;
	file: string;
	players: string;
	/** What the format calls its tracks and playlists, when not that. */
	holds?: readonly [string, string];
}[];

type FormatKey = (typeof FORMATS)[number]["key"];

function summaryText(s: UsbLibrarySummary, holds: readonly [string, string]): string {
	const count = (n: number, one: string) => plural(n, one, `${one}s`);
	return s.tracks === 0 ? "Empty" : `${count(s.tracks, holds[0])}, ${count(s.playlists, holds[1])}`;
}

/** What to tell the user when rekordbox's two formats do not cover every player with the same songs. */
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

function formatStatus(
	f: UsbFormats | undefined,
	failed: boolean,
	format: (typeof FORMATS)[number],
): FormatStatus {
	const key: FormatKey = format.key;
	if (!f) {
		return failed
			? { short: "?", text: "Could not check", tone: "off" }
			: { short: "…", text: "Checking…", tone: "off" };
	}
	const error = key === "playlistFolders" ? null : f[`${key}Error`];
	if (error) {
		return { short: "Unreadable", text: "Could not be read", tone: "error", error };
	}
	const summary = f[key];
	if (!summary) {
		return { short: "None", text: "Not on this drive", tone: "off" };
	}
	return {
		short: summary.tracks.toLocaleString(),
		text: summaryText(summary, "holds" in format ? format.holds : ["track", "playlist"]),
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

/** The drive's library formats as pills; each opens the detail and which players read it. */
function FormatPills({ mount }: { mount: string }) {
	const formats = useQuery({ queryKey: ["usb-formats", mount], queryFn: () => usbFormats(mount) });
	const rekordboxAdvice = formats.data ? formatsAdvice(formats.data) : null;
	return (
		<div className="flex flex-wrap gap-1.5 pt-1">
			{FORMATS.map((format) => {
				const status = formatStatus(formats.data, formats.isError, format);
				// The advice is about rekordbox's two libraries disagreeing; the others are not part of it.
				const advice =
					format.key === "deviceLibrary" || format.key === "oneLibrary" ? rekordboxAdvice : null;
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
							{format.brand ? (
								<BrandGlyph brand={format.brand} className="size-3.5" />
							) : (
								<FolderTree aria-hidden="true" className="size-3.5 text-muted-foreground" />
							)}
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
			<SettingRows title="Drive">
				<BackupsRow drive={drive} />
				<ResetRow drive={drive} />
			</SettingRows>
		</div>
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
		<SettingRow label={<SettingLabel icon={<Archive />} title="Library backups" hint={hint} />}>
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
						The newest backup stays. The others are deleted from the drive for good, so the space
						frees up now.
					</p>
					{prune.isError && <ErrorLine>{String(prune.error)}</ErrorLine>}
				</ConfirmDialog>
			)}
			{backups.isError && <ErrorLine>{String(backups.error)}</ErrorLine>}
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
				<SettingLabel
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
							{isMac
								? "The rekordbox library (both formats), the Serato, VirtualDJ and Gemini libraries, analysis files, artwork and every song in Contents and Playlists move to the drive's Trash. Players will show the drive as empty. The space frees up when you empty the Trash; until then you can put them back from it."
								: "The rekordbox library (both formats), the Serato, VirtualDJ and Gemini libraries, analysis files, artwork and every song in Contents and Playlists are deleted from the drive for good (Windows keeps no Recycle Bin on USB drives). Players will show the drive as empty."}
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
						{reset.isError && <ErrorLine>{String(reset.error)}</ErrorLine>}
					</div>
				</ConfirmDialog>
			)}
		</SettingRow>
	);
}
