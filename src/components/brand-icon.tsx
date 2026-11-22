import { Download, Library, Usb } from "lucide-react";
import {
	type SimpleIcon,
	siCloudflare,
	siDiscogs,
	siItunes,
	siJellyfin,
	siMusicbrainz,
	siPioneerdj,
	siTailscale,
} from "simple-icons";
import { cn } from "#/lib/utils.ts";

/** Services with a published logo (from Simple Icons), drawn in the service's own colour. */
const LOGOS = {
	cloudflare: { icon: siCloudflare, label: "Cloudflare" },
	tailscale: { icon: siTailscale, label: "Tailscale" },
	itunes: { icon: siItunes, label: "iTunes" },
	rekordbox: { icon: siPioneerdj, label: "rekordbox" },
	musicbrainz: { icon: siMusicbrainz, label: "MusicBrainz" },
	discogs: { icon: siDiscogs, label: "Discogs" },
	jellyfin: { icon: siJellyfin, label: "Jellyfin" },
} as const satisfies Record<string, { icon: SimpleIcon; label: string }>;

/**
 * Services Simple Icons has no logo for. They get their initials on a plain tile rather than a
 * drawing that only looks like their logo.
 */
const LETTERMARKS = {
	serato: { letters: "S", label: "Serato" },
	virtualdj: { letters: "VDJ", label: "VirtualDJ" },
	gemini: { letters: "G", label: "Gemini" },
} as const;

type Logo = keyof typeof LOGOS;
type Lettermark = keyof typeof LETTERMARKS;

/** A third-party service, or one of the app's own places that sits among them. */
export type Brand = Logo | Lettermark | "downloads" | "usb" | "library";

const isLogo = (brand: Brand): brand is Logo => brand in LOGOS;
const isLettermark = (brand: Brand): brand is Lettermark => brand in LETTERMARKS;

/**
 * Whether a logo colour is too dark to read on the app's dark surfaces, as Discogs' near-black
 * is; such logos are drawn in the text colour instead.
 */
function isDark(hex: string): boolean {
	const n = Number.parseInt(hex, 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 70;
}

const TILE =
	"grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-black/5 dark:ring-white/10";

/** Brand glyph on a tile in the brand's colour. The app's own places get a neutral tile. */
export function BrandIcon({ brand, className }: { brand: Brand; className?: string }) {
	if (brand === "library") {
		return (
			<span
				role="img"
				aria-label="Library"
				className={cn(TILE, "bg-primary/15 text-primary ring-primary/20", className)}
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
				className={cn(TILE, "bg-muted", className)}
			>
				<Icon className="size-[55%] text-muted-foreground" />
			</span>
		);
	}
	if (isLettermark(brand)) {
		const mark = LETTERMARKS[brand];
		return (
			<span
				role="img"
				aria-label={mark.label}
				className={cn(TILE, "@container bg-muted font-semibold text-foreground/80", className)}
			>
				<span aria-hidden="true" className="text-[min(42cqw,1rem)] leading-none tracking-tight">
					{mark.letters}
				</span>
			</span>
		);
	}
	const { icon, label } = LOGOS[brand];
	return (
		<span
			role="img"
			aria-label={label}
			className={cn(TILE, className)}
			style={{ backgroundColor: `#${icon.hex}` }}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true" className="size-[55%] fill-white">
				<path d={icon.path} />
			</svg>
		</span>
	);
}

/**
 * A service's mark without a tile, to sit beside its name in running text, a pill or a menu:
 * the logo in its own colour (or the text colour, when that is too dark to read), or its initials.
 * Sized by `className` (default 1rem). The name beside it is the label, so it is hidden from
 * screen readers.
 */
export function BrandGlyph({ brand, className }: { brand: Logo | Lettermark; className?: string }) {
	if (isLogo(brand)) {
		const { icon } = LOGOS[brand];
		return (
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				className={cn("size-4 shrink-0", isDark(icon.hex) && "fill-current", className)}
				style={isDark(icon.hex) ? undefined : { fill: `#${icon.hex}` }}
			>
				<path d={icon.path} />
			</svg>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-[4px] bg-white/10 px-0.5 font-semibold text-[0.5625rem] leading-none tracking-tight",
				className,
			)}
		>
			{LETTERMARKS[brand].letters}
		</span>
	);
}
