import { ArrowLeft, Play, X } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";
import { typeScale } from "#/lib/type-scale.ts";

/** The artwork frame every panel header uses, so songs, albums and artists line up. */
export const PANEL_ART = "size-full rounded-lg shadow-lg ring-1 ring-foreground/10";

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
	/** A status in the top right corner, e.g. whether it is synced. */
	badge?: ReactNode;
	/** Figures with an icon each (length, tempo, key), right-aligned beside Play. */
	facts?: readonly Fact[];
}

export interface Fact {
	icon: ReactNode;
	label: string;
	/** What the figure is, on hover. */
	title: string;
}

/** Shared header for slide-over panels: art, what it is, title, figures, then Play and actions. */
export function PanelHeader({
	kind,
	title,
	subtitle,
	meta,
	art,
	tracks,
	actions,
	badge,
	facts,
}: Props) {
	const player = usePlayer();
	// The art is a square as tall as the text beside it, so the two always line up.
	const text = useRef<HTMLDivElement>(null);
	const [side, setSide] = useState<number | null>(null);
	useLayoutEffect(() => {
		const el = text.current;
		if (!el) {
			return;
		}
		const measure = () => setSide(el.offsetHeight);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return (
		<div className="flex items-start gap-4 @lg/split:gap-5">
			{art && (
				<div
					className="shrink-0"
					style={side === null ? { visibility: "hidden" } : { width: side, height: side }}
				>
					{art}
				</div>
			)}
			<div ref={text} className="min-w-0 flex-1 space-y-3">
				<div className="space-y-1">
					{(kind ?? badge) && (
						<div className="flex items-center justify-between gap-3 text-muted-foreground text-xs [&_svg]:size-3.5">
							<div className="flex items-center gap-1.5">{kind}</div>
							{badge}
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
					{facts && facts.length > 0 && (
						<dl className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-muted-foreground text-xs tabular-nums">
							{facts.map((f) => (
								<div key={f.title} className="flex items-center gap-1" title={f.title}>
									<dt className="sr-only">{f.title}</dt>
									<span aria-hidden="true" className="[&_svg]:size-3.5">
										{f.icon}
									</span>
									<dd>{f.label}</dd>
								</div>
							))}
						</dl>
					)}
				</div>
			</div>
		</div>
	);
}

/** Top bar of the drawer and the left split: Back when there is history, and Close. */
export function PanelBar({
	canGoBack,
	onBack,
	onClose,
	closeLabel,
}: {
	canGoBack: boolean;
	onBack: () => void;
	onClose: () => void;
	closeLabel: string;
}) {
	return (
		<div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
			<Button
				variant="ghost"
				size="sm"
				onClick={onBack}
				disabled={!canGoBack}
				className={canGoBack ? "" : "invisible"}
			>
				<ArrowLeft /> Back
			</Button>
			<Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}>
				<X />
			</Button>
		</div>
	);
}
