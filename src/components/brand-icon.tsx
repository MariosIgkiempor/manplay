import { Download, Library, Usb } from "lucide-react";
import { siCloudflare, siItunes, siPioneerdj, siTailscale } from "simple-icons";
import { cn } from "#/lib/utils.ts";

const BRANDS = {
	cloudflare: { icon: siCloudflare, label: "Cloudflare" },
	tailscale: { icon: siTailscale, label: "Tailscale" },
	itunes: { icon: siItunes, label: "iTunes" },
	rekordbox: { icon: siPioneerdj, label: "rekordbox" },
} as const;

export type Brand = keyof typeof BRANDS | "downloads" | "usb" | "library";

/** Brand glyph on a tile in the brand's colour. "downloads" is not a brand, so it gets a neutral tile. */
export function BrandIcon({ brand, className }: { brand: Brand; className?: string }) {
	const tile =
		"grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-black/5 dark:ring-white/10";
	if (brand === "library") {
		return (
			<span
				role="img"
				aria-label="Library"
				className={cn(tile, "bg-primary/15 text-primary ring-primary/20", className)}
			>
				<Library className="size-[55%]" />
			</span>
		);
	}
	if (brand === "downloads" || brand === "usb") {
		const Icon = brand === "usb" ? Usb : Download;
		return (
			<span
				role="img"
				aria-label={brand === "usb" ? "USB drive" : "Downloads"}
				className={cn(tile, "bg-muted", className)}
			>
				<Icon className="size-[55%] text-muted-foreground" />
			</span>
		);
	}
	const { icon, label } = BRANDS[brand];
	return (
		<span
			role="img"
			aria-label={label}
			className={cn(tile, className)}
			style={{ backgroundColor: `#${icon.hex}` }}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true" className="size-[55%] fill-white">
				<path d={icon.path} />
			</svg>
		</span>
	);
}
