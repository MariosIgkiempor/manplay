import { ArrowLeft, Play, X } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "#/components/page-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import { usePlayer } from "#/context/player-context.ts";
import type { Track } from "#/lib/api.ts";

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
	/** Figures with an icon each (length, tempo, key), after the other figures. */
	facts?: readonly Fact[];
	/** Tabs on the header's bottom edge. */
	tabs?: ReactNode;
	/** Inside other content (e.g. a drive's playlist): no band of its own. */
	plain?: boolean;
}

export interface Fact {
	icon: ReactNode;
	label: string;
	/** What the figure is, on hover. */
	title: string;
}

/** Figures with icons, after the other figures. */
function Facts({ facts }: { facts: readonly Fact[] }) {
	return (
		<dl className="contents">
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
	);
}

/** The shared header in a panel (song, album, artist, tag value): art, title, Play and figures. */
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
	tabs,
	plain = false,
}: Props) {
	const player = usePlayer();
	return (
		<PageHeader
			variant={plain ? "plain" : "panel"}
			art={art && <div className="size-24 shrink-0 @lg/split:size-28">{art}</div>}
			kind={kind}
			badge={badge}
			title={title}
			subtitle={subtitle}
			meta={
				(meta !== undefined || (facts && facts.length > 0)) && (
					<>
						{meta}
						{facts && facts.length > 0 && <Facts facts={facts} />}
					</>
				)
			}
			tabs={tabs}
			actions={
				<>
					<Button size="sm" disabled={tracks.length === 0} onClick={() => player.play(tracks, 0)}>
						<Play /> Play
					</Button>
					{actions}
				</>
			}
		/>
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
