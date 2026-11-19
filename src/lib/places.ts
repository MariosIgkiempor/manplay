import { useNavigate } from "@tanstack/react-router";
import type { Brand } from "#/components/brand-icon.tsx";
import { isR2, targetShortName } from "#/lib/api.ts";
import { useSyncTargets } from "#/lib/queries.ts";
import { useRekordbox } from "#/lib/use-rekordbox.ts";
import { useUsbDrives } from "#/lib/use-usb.ts";

/** Kinds of export destination that can be added. */
export const DESTINATION_SERVICES = ["tailscale", "r2", "rekordbox", "usb"] as const;
export type DestinationService = (typeof DESTINATION_SERVICES)[number];

/** One import source or export destination, as its page and the pickers name it. */
export type PlaceKey =
	| `target:${number}`
	| "rekordbox"
	| `usb:${string}`
	| "downloads"
	| "itunes"
	| "add";

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
	const rekordbox = useRekordbox().status.data;
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
		...(rekordbox?.path
			? [
					{
						key: "rekordbox",
						label: "Rekordbox XML",
						brand: "rekordbox",
						go: () => void navigate({ to: "/export/rekordbox" }),
					} satisfies PlaceOption,
				]
			: []),
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

/** Both import sources. */
export function useImportPlaces(): PlaceOption[] {
	const navigate = useNavigate();
	return [
		{
			key: "downloads",
			label: "Downloads",
			brand: "downloads",
			go: () => void navigate({ to: "/import/downloads" }),
		},
		{
			key: "itunes",
			label: "iTunes",
			brand: "itunes",
			go: () => void navigate({ to: "/import/itunes" }),
		},
	];
}
