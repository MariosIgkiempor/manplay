import { Mic2 } from "lucide-react";
import * as React from "react";
import { useDetailNav } from "#/context/detail-context.ts";
import { splitNames } from "#/lib/names.ts";
import { cn } from "#/lib/utils.ts";

/**
 * Artist credit as one link per name, so an album or song by `A; B` opens either artist.
 * An empty credit renders nothing.
 */
export function ArtistLinks({
	artist,
	className,
	icon = false,
}: {
	artist: string;
	className?: string;
	/** Lead with the artist icon, where neighbouring figures have icons too. */
	icon?: boolean;
}) {
	const go = useDetailNav();
	const names = splitNames(artist);
	if (names.length === 0) {
		return null;
	}
	const links = names.map((name, i) => (
		<React.Fragment key={name}>
			{i > 0 && ", "}
			<button
				type="button"
				className={cn("hover:text-foreground hover:underline", className)}
				onClick={() => go({ kind: "artist", name })}
			>
				{name}
			</button>
		</React.Fragment>
	));
	if (!icon) {
		return (
			<span className="min-w-0 truncate" title={names.join(", ")}>
				{links}
			</span>
		);
	}
	return (
		<span className="flex min-w-0 items-center gap-1" title={names.join(", ")}>
			<Mic2 aria-hidden="true" className="size-3 shrink-0 opacity-60" />
			<span className="min-w-0 truncate">{links}</span>
		</span>
	);
}
