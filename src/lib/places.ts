import { useNavigate } from "@tanstack/react-router";
import type { Brand } from "#/components/brand-icon.tsx";
import { isR2, targetShortName } from "#/lib/api.ts";
import { folderBrand, folderName } from "#/lib/import-folders.ts";
import { useSyncTargets } from "#/lib/queries.ts";
import { useImportFolders } from "#/lib/use-import.ts";
import { useUsbDrives } from "#/lib/use-usb.ts";

/** Kinds of export destination that can be added. */
export const DESTINATION_SERVICES = ["tailscale", "r2", "usb"] as const;
export type DestinationService = (typeof DESTINATION_SERVICES)[number];

/** One import source or export destination, as its page and the pickers name it. */
export type PlaceKey = `target:${number}` | `usb:${string}` | `import:${number}` | "add";

export type PlaceSection = "import" | "export";

export interface PlaceOption {
	key: PlaceKey;
	label: string;
	brand: Brand;
	go: () => void;
}

/** Every export destination there is now, in sidebar order. */
export function useExportPlaces(): PlaceOption[] {
	const navigate = useNavigate();
	const targets = useSyncTargets().data ?? [];
	const drives = useUsbDrives().data ?? [];
	return [
		...targets.map(
			(t): PlaceOption => ({
				key: `target:${t.id}`,
				label: targetShortName(t),
				brand: isR2(t) ? "cloudflare" : "tailscale",
				go: () => void navigate({ to: "/export/$targetId", params: { targetId: t.id } }),
			}),
		),
		...drives.map(
			(d): PlaceOption => ({
				key: `usb:${d.mount}`,
				label: d.name,
				brand: "usb",
				go: () => void navigate({ to: "/export/usb", search: { mount: d.mount } }),
			}),
		),
	];
}

/** Every import folder, in sidebar order. */
export function useImportPlaces(): PlaceOption[] {
	const navigate = useNavigate();
	const folders = useImportFolders().data ?? [];
	return folders.map(
		(f): PlaceOption => ({
			key: `import:${f.id}`,
			label: folderName(f.path),
			brand: folderBrand(f.path),
			go: () => void navigate({ to: "/import/$folderId", params: { folderId: f.id } }),
		}),
	);
}
