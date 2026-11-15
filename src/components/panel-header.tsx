import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";
import { typeScale } from "#/lib/type-scale.ts";

interface Props {
	/** What is shown, e.g. "Album" or "Genre", with an optional icon. */
	kind?: ReactNode;
	title: string;
	subtitle?: ReactNode;
	meta?: ReactNode;
	art?: ReactNode;
	tracks: readonly Track[];
	/** Buttons beside Play. */
	actions?: ReactNode;
}

/** Shared header for slide-over panels: art, what it is, title, figures, then Play and actions. */
export function PanelHeader({ kind, title, subtitle, meta, art, tracks, actions }: Props) {
	const player = usePlayer();
	return (
		<div className="flex items-end gap-5">
			{art}
			<div className="min-w-0 flex-1 space-y-3">
				<div className="space-y-1">
					{kind && (
						<div className="flex items-center gap-1.5 text-muted-foreground text-xs [&_svg]:size-3.5">
							{kind}
						</div>
					)}
					<h2 className={`truncate ${typeScale.panelTitle}`} title={title}>
						{title}
					</h2>
					{subtitle && <div className="truncate text-muted-foreground text-sm">{subtitle}</div>}
					{meta && (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs tabular-nums">
							{meta}
						</div>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" disabled={tracks.length === 0} onClick={() => player.play(tracks, 0)}>
						<Play /> Play
					</Button>
					{actions}
				</div>
			</div>
		</div>
	);
}
