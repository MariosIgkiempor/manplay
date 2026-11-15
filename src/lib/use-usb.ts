import { useQuery } from "@tanstack/react-query";
import { type UsbDrive, usbDrives, usbLibrary } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";

/** Plugged-in drives, re-checked every few seconds so plugging one in shows up on its own. */
export function useUsbDrives() {
	return useQuery({ queryKey: ["usb-drives"], queryFn: usbDrives, refetchInterval: 3000 });
}

export function useUsbLibrary(mount: string | null) {
	return useQuery({
		queryKey: ["usb-library", mount],
		queryFn: () => usbLibrary(mount ?? ""),
		enabled: mount !== null,
	});
}

export function space(d: UsbDrive): string {
	return `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`;
}
