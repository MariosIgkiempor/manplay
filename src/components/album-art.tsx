import { Music } from "lucide-react";
import { useState } from "react";
import { artUrl } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

interface Props {
	trackId: number;
	className?: string;
}

function ArtImage({ trackId, className }: Props) {
	const [failed, setFailed] = useState(false);
	return (
		<div className={cn("relative aspect-square overflow-hidden bg-muted", className)}>
			{failed ? (
				<div className="flex size-full items-center justify-center text-muted-foreground">
					<Music className="size-1/3" />
				</div>
			) : (
				<img
					src={artUrl(trackId)}
					alt=""
					loading="lazy"
					decoding="async"
					draggable={false}
					className="size-full object-cover"
					onError={() => setFailed(true)}
				/>
			)}
		</div>
	);
}

/** Album cover with a placeholder when the track has no artwork. */
export function AlbumArt(props: Props) {
	// Keyed so the "failed" state resets when a different track is shown.
	return <ArtImage key={props.trackId} {...props} />;
}
