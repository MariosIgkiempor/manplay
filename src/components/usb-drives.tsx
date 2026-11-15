import { TriangleAlert, Usb } from "lucide-react";
import { ErrorText } from "#/components/error-text.tsx";
import { EmptyState } from "#/components/page.tsx";
import { UsbBrowser } from "#/components/usb-browser.tsx";
import { UsbExportButton } from "#/components/usb-export.tsx";
import type { UsbDrive } from "#/lib/api.ts";
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
			{drive.hasOneLibrary && (
				<p
					className="flex items-center gap-2 text-muted-foreground text-xs"
					title="The CDJ-3000X, Opus Quad, XDJ-AZ and Omnis Duo read OneLibrary; other players read the Device Library shown here. Editing or exporting from manplay moves the OneLibrary files to a backup folder on the drive, so every player reads the same library."
				>
					<TriangleAlert className="size-3.5 shrink-0 text-warning" />
					Also has a OneLibrary database. Changes here move it to a backup.
				</p>
			)}
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
		</div>
	);
}
