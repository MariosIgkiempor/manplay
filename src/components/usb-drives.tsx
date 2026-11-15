import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eraser, Minus, TriangleAlert, Usb } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { EmptyState, Section } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { UsbBrowser } from "#/components/usb-browser.tsx";
import { UsbExportButton } from "#/components/usb-export.tsx";
import {
	type UsbDrive,
	type UsbFormats,
	type UsbLibrarySummary,
	usbFormats,
	usbReset,
} from "#/lib/api.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { space, useUsbDrives, useUsbLibrary } from "#/lib/use-usb.ts";
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

function DriveDetail({ drive }: { drive: UsbDrive }) {
	const library = useUsbLibrary(drive.hasLibrary ? drive.mount : null);
	return (
		<div className="space-y-5 pb-6">
			<div className="flex items-end justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<Usb className="size-3.5" /> CDJ USB
					</div>
					<h2 className={cn("truncate", typeScale.panelTitle)}>{drive.name}</h2>
					<p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs tabular-nums">
						<span>{space(drive)}</span>
						{drive.filesystem && <span>{drive.filesystem.toUpperCase()}</span>}
						{!drive.writable && <span className="text-warning">Read-only</span>}
						{library.data && <span>{plural(library.data.tracks.length, "track", "tracks")}</span>}
					</p>
				</div>
				<UsbExportButton drive={drive} library={library.data} />
			</div>
			{(drive.hasLibrary || drive.hasOneLibrary) && <DriveFormats mount={drive.mount} />}
			{library.isError && <ErrorText message={String(library.error)} />}
			{!drive.hasLibrary && (
				<EmptyState icon={<Usb />} title="No rekordbox library yet">
					Export playlists to create one.
				</EmptyState>
			)}
			{library.isPending && drive.hasLibrary && <EmptyState title="Reading library…" />}
			{library.data && drive.hasLibrary && (
				<UsbBrowser mount={drive.mount} library={library.data} editable={drive.writable} />
			)}
			{drive.writable && (drive.hasLibrary || drive.hasOneLibrary) && <ResetDrive drive={drive} />}
		</div>
	);
}

/**
 * Starts the drive afresh. Everything an export puts there (both libraries, analysis files,
 * artwork, the songs in Contents) goes to the drive's Trash, after typing the drive's name.
 */
function ResetDrive({ drive }: { drive: UsbDrive }) {
	const queryClient = useQueryClient();
	const [asking, setAsking] = useState(false);
	const [typed, setTyped] = useState("");
	const field = useId();
	const reset = useMutation({
		mutationFn: () => usbReset(drive.mount),
		onSuccess: async () => {
			setAsking(false);
			setTyped("");
			for (const key of ["usb-drives", "usb-library", "usb-formats"]) {
				await queryClient.invalidateQueries({ queryKey: [key] });
			}
		},
	});
	return (
		<Section title="Reset drive">
			<div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 p-3">
				<p className="text-muted-foreground text-xs">
					Removes the rekordbox library, analysis and exported songs, so the next export starts
					fresh. Player settings stay.
				</p>
				<Button
					variant="outline"
					className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
					onClick={() => {
						reset.reset();
						setAsking(true);
					}}
				>
					<Eraser /> Reset drive…
				</Button>
			</div>
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
		</Section>
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

function summaryText(s: UsbLibrarySummary): string {
	return s.tracks === 0
		? "Empty"
		: `${plural(s.tracks, "track", "tracks")} · ${plural(s.playlists, "playlist", "playlists")}`;
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

type FormatKey = (typeof FORMATS)[number]["key"];

/** One format's line ("41 tracks · 5 playlists") and icon. */
function formatStatus(f: UsbFormats | undefined, failed: boolean, key: FormatKey) {
	const none = <Minus className="size-4 shrink-0 text-muted-foreground" />;
	if (!f) {
		return { text: failed ? "Could not check" : "Checking…", icon: none };
	}
	const error = f[`${key}Error`];
	if (error) {
		return {
			text: "Could not be read",
			error,
			icon: <TriangleAlert className="size-4 shrink-0 text-destructive" />,
		};
	}
	const summary = f[key];
	if (!summary) {
		return { text: "Not on this drive", icon: none };
	}
	const icon = summary.tracks > 0 ? <Check className="size-4 shrink-0 text-success" /> : none;
	return { text: summaryText(summary), icon };
}

/** The drive's library formats, side by side with the players each one covers. */
function DriveFormats({ mount }: { mount: string }) {
	const formats = useQuery({ queryKey: ["usb-formats", mount], queryFn: () => usbFormats(mount) });
	const advice = formats.data ? formatsAdvice(formats.data) : null;
	return (
		<section className="space-y-2">
			<div className="grid gap-2 sm:grid-cols-2">
				{FORMATS.map((format) => {
					const status = formatStatus(formats.data, formats.isError, format.key);
					return (
						<div key={format.key} className="space-y-1 rounded-lg border p-3 text-xs">
							<p className="flex items-center gap-2 font-medium text-sm">
								{status.icon}
								{format.name}
								<code className="font-normal text-muted-foreground text-xs">{format.file}</code>
							</p>
							<p title={status.error}>{status.text}</p>
							<p className="text-muted-foreground">{format.players}</p>
						</div>
					);
				})}
			</div>
			{advice && (
				<p className="flex gap-2 rounded-lg border p-3 text-muted-foreground text-xs">
					<TriangleAlert className="size-4 shrink-0" />
					{advice}
				</p>
			)}
		</section>
	);
}
