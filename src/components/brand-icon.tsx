import { Download, Folder, Library, Usb } from "lucide-react";
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
import { type BrandArtwork, type BrandMark, GEMINI, SERATO, VIRTUALDJ } from "#/lib/brand-logos.ts";
import { cn } from "#/lib/utils.ts";

/** A logo in one colour, drawn in that colour or in white on a tile of it. */
interface Mark {
	path: string;
	/** Without the `#`. */
	hex: string;
	viewBox: string;
	/** Traced marks keep their white parts as holes. */
	evenOdd: boolean;
}

const simple = (icon: SimpleIcon): Mark => ({
	path: icon.path,
	hex: icon.hex,
	viewBox: "0 0 24 24",
	evenOdd: false,
});
const traced = (mark: BrandMark): Mark => ({ ...mark, evenOdd: true });

/**
 * Services with a published logo, drawn in the service's own colour: from Simple Icons, or from
 * the brand's own files where Simple Icons has none (`brand-logos.ts`).
 */
const LOGOS = {
	cloudflare: { mark: simple(siCloudflare), label: "Cloudflare" },
	tailscale: { mark: simple(siTailscale), label: "Tailscale" },
	itunes: { mark: simple(siItunes), label: "iTunes" },
	rekordbox: { mark: simple(siPioneerdj), label: "rekordbox" },
	musicbrainz: { mark: simple(siMusicbrainz), label: "MusicBrainz" },
	discogs: { mark: simple(siDiscogs), label: "Discogs" },
	jellyfin: { mark: simple(siJellyfin), label: "Jellyfin" },
	serato: { mark: traced(SERATO), label: "Serato" },
	gemini: { mark: traced(GEMINI), label: "Gemini" },
} as const satisfies Record<string, { mark: Mark; label: string }>;

/** Logos in several colours, which only read drawn as they are, on a light tile. */
const ARTWORK = {
	virtualdj: { art: VIRTUALDJ, label: "VirtualDJ" },
} as const satisfies Record<string, { art: BrandArtwork; label: string }>;

type Logo = keyof typeof LOGOS;
type Artwork = keyof typeof ARTWORK;

/** A third-party service, or one of the app's own places that sits among them. */
export type Brand = Logo | Artwork | "downloads" | "folder" | "usb" | "library";

const isArtwork = (brand: Brand): brand is Artwork => brand in ARTWORK;

/** A logo's layers as SVG paths; a layer without a fill takes the text colour. */
function ArtworkSvg({ art, className }: { art: BrandArtwork; className?: string }) {
	return (
		<svg viewBox={art.viewBox} aria-hidden="true" className={className}>
			{art.layers.map((l) => (
				<path key={l.path.slice(0, 24)} d={l.path} fill={l.fill ?? "currentColor"} />
			))}
		</svg>
	);
}

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

/** The app's own kinds of place, drawn on a neutral tile. */
const OWN_PLACES = {
	downloads: { Icon: Download, label: "Downloads" },
	folder: { Icon: Folder, label: "Folder" },
	usb: { Icon: Usb, label: "USB drive" },
} as const;

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
	if (brand === "downloads" || brand === "folder" || brand === "usb") {
		const place = OWN_PLACES[brand];
		return (
			<span role="img" aria-label={place.label} className={cn(TILE, "bg-muted", className)}>
				<place.Icon className="size-[55%] text-muted-foreground" />
			</span>
		);
	}
	if (isArtwork(brand)) {
		const artwork = ARTWORK[brand];
		return (
			// Light in both themes, like the logo's own background; its dark parts stay dark.
			<span
				role="img"
				aria-label={artwork.label}
				className={cn(TILE, "bg-white text-[#202020]", className)}
			>
				<ArtworkSvg art={artwork.art} className="size-[70%]" />
			</span>
		);
	}
	const { mark, label } = LOGOS[brand];
	return (
		<span
			role="img"
			aria-label={label}
			className={cn(TILE, className)}
			style={{ backgroundColor: `#${mark.hex}` }}
		>
			<svg viewBox={mark.viewBox} aria-hidden="true" className="size-[55%] fill-white">
				<path d={mark.path} fillRule={mark.evenOdd ? "evenodd" : undefined} />
			</svg>
		</span>
	);
}

/**
 * A service's mark without a tile, to sit beside its name in running text, a pill or a menu: the
 * logo in its own colours (or the text colour, when its colour is too dark to read). Sized by
 * `className` (default 1rem). The name beside it is the label, so it is hidden from screen readers.
 */
export function BrandGlyph({ brand, className }: { brand: Logo | Artwork; className?: string }) {
	if (isArtwork(brand)) {
		return <ArtworkSvg art={ARTWORK[brand].art} className={cn("size-4 shrink-0", className)} />;
	}
	const { mark } = LOGOS[brand];
	const dark = isDark(mark.hex);
	return (
		<svg
			viewBox={mark.viewBox}
			aria-hidden="true"
			className={cn("size-4 shrink-0", dark && "fill-current", className)}
			style={dark ? undefined : { fill: `#${mark.hex}` }}
		>
			<path d={mark.path} fillRule={mark.evenOdd ? "evenodd" : undefined} />
		</svg>
	);
}
