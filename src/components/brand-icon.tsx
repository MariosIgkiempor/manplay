import { Download } from "lucide-react";
import { siCloudflare, siItunes, siPioneerdj, siTailscale } from "simple-icons";
import { cn } from "#/lib/utils.ts";

const BRANDS = {
	cloudflare: { icon: siCloudflare, label: "Cloudflare" },
	tailscale: { icon: siTailscale, label: "Tailscale" },
	itunes: { icon: siItunes, label: "iTunes" },
	rekordbox: { icon: siPioneerdj, label: "Rekordbox" },
} as const;

export type Brand = keyof typeof BRANDS | "downloads";

/** Brand glyph on a tile in the brand's colour. "downloads" is not a brand, so it gets a neutral tile. */
export function BrandIcon({ brand, className }: { brand: Brand; className?: string }) {
	const tile =
		"grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-black/5 dark:ring-white/10";
	if (brand === "downloads") {
		return (
			<span role="img" aria-label="Downloads" className={cn(tile, "bg-muted", className)}>
				<Download className="size-[55%] text-muted-foreground" />
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
