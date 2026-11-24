import { Disc3, Mic2 } from "lucide-react";
import { cn } from "#/lib/utils.ts";

/**
 * Who a song or album is by and what it is on, written the one way it is under every title in
 * the app: small and quiet, a microphone before the artist and a disc before the album. Plain
 * text; a song row's own line (`track-list.tsx`) is the same with each name a link.
 */
export function CreditLine({
	artist,
	album,
	className,
}: {
	artist?: string | undefined;
	album?: string | undefined;
	className?: string;
}) {
	const by = artist?.trim() ?? "";
	const on = album?.trim() ?? "";
	if (by === "" && on === "") {
		return null;
	}
	return (
		<span
			className={cn("flex min-w-0 items-center gap-2 text-muted-foreground text-xs", className)}
		>
			{by !== "" && (
				<span className="flex min-w-0 items-center gap-1" data-hint={by}>
					<Mic2 aria-hidden="true" className="size-3 shrink-0 opacity-60" />
					<span className="min-w-0 truncate">{by}</span>
				</span>
			)}
			{on !== "" && (
				<span className="flex min-w-0 shrink items-center gap-1" data-hint={on}>
					<Disc3 aria-hidden="true" className="size-3 shrink-0 opacity-60" />
					<span className="min-w-0 truncate">{on}</span>
				</span>
			)}
		</span>
	);
}
