import { useQuery } from "@tanstack/react-query";
import { ChevronRight, TriangleAlert, Usb } from "lucide-react";
import { useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { EmptyState, Section } from "#/components/page.tsx";
import { SourceCard } from "#/components/source-card.tsx";
import { SourcePanel } from "#/components/source-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { UsbBrowser } from "#/components/usb-browser.tsx";
import { UsbExportButton } from "#/components/usb-export.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { type UsbDrive, usbDrives, usbLibrary } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { useServices } from "#/lib/queries.ts";
import { typeScale } from "#/lib/type-scale.ts";
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
			subtitle="Rekordbox libraries on Pioneer CDJ and XDJ drives"
			enabled={enabled}
			onToggle={setEnabled}
		>
			<Section title="Plugged in" count={list.length}>
				{drives.isError && <ErrorText message={String(drives.error)} />}
				{list.length === 0 ? (
					<EmptyState icon={<Usb />} title="No USB drive plugged in">
						Drives show up here as soon as you plug them in.
					</EmptyState>
				) : (
					<ul className="divide-y">
						{list.map((d) => (
							<DriveRow key={d.mount} drive={d} onOpen={() => setSelected(d.mount)} />
						))}
					</ul>
				)}
			</Section>
			<Drawer
				open={drive !== undefined}
				onClose={() => setSelected(null)}
				title={drive?.name ?? ""}
				width="w-[60rem]"
			>
				{drive && <DriveDetail drive={drive} />}
			</Drawer>
		</SourcePanel>
	);
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
