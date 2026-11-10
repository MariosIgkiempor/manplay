import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";

interface Props {
	title: string;
	subtitle?: ReactNode;
	meta?: ReactNode;
	art?: ReactNode;
	tracks: readonly Track[];
}

/** Shared header for slide-over panels: art, title, meta line and a Play button. */
export function PanelHeader({ title, subtitle, meta, art, tracks }: Props) {
	const player = usePlayer();
	return (
		<div className="flex items-end gap-5">
			{art}
			<div className="min-w-0 space-y-2">
				<h2 className="truncate font-bold text-2xl" title={title}>
					{title}
				</h2>
				{subtitle && <div className="text-lg text-muted-foreground">{subtitle}</div>}
				{meta && (
					<div className="flex items-center gap-3 text-muted-foreground text-sm">{meta}</div>
				)}
				<Button disabled={tracks.length === 0} onClick={() => player.play(tracks, 0)}>
					<Play /> Play
				</Button>
			</div>
		</div>
	);
}
