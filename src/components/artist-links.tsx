import * as React from "react";
import { useDetailNav } from "#/context/detail-context.ts";
import { splitNames } from "#/lib/names.ts";
import { cn } from "#/lib/utils.ts";

/**
 * Artist credit as one link per name, so an album or song by `A; B` opens either artist.
 * An empty credit renders nothing.
 */
export function ArtistLinks({ artist, className }: { artist: string; className?: string }) {
	const go = useDetailNav();
	const names = splitNames(artist);
	if (names.length === 0) {
		return null;
	}
	return (
		<span className="min-w-0 truncate" title={names.join(", ")}>
			{names.map((name, i) => (
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
			))}
		</span>
	);
}
