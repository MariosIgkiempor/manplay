import { Popover, PopoverTrigger } from "@ui-sdk/react/popover";
import {
	ArrowUpRight,
	Check,
	Info,
	type LucideIcon,
	RefreshCw,
	TriangleAlert,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { PopoverPopup } from "#/components/ui/popup.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * What happens to something an action or setting touches:
 * - `changed`: is rewritten or redone.
 * - `sent`: leaves this computer.
 * - `lost`: is removed or cleared.
 * - `kept`: stays as it is.
 * - `warn`: worth knowing before going on.
 * - `info`: plain detail.
 */
export type EffectTone = "changed" | "sent" | "lost" | "kept" | "warn" | "info";

/** One thing touched, and optionally a line on how. */
export interface Effect {
	tone: EffectTone;
	what: ReactNode;
	detail?: ReactNode;
}

interface ToneLook {
	/** The group's name in the card. */
	label: string;
	icon: LucideIcon;
	/** Colour of the mark and the group's name. */
	text: string;
	/** Tint behind the mark. */
	tint: string;
}

/** In the order the card lists them: what changes first, what stays last. */
const TONE_ORDER: readonly EffectTone[] = ["changed", "sent", "lost", "kept", "warn", "info"];

const TONES: Record<EffectTone, ToneLook> = {
	changed: { label: "Redone", icon: RefreshCw, text: "text-primary", tint: "bg-primary/12" },
	sent: { label: "Sent out", icon: ArrowUpRight, text: "text-warning", tint: "bg-warning/12" },
	lost: { label: "Removed", icon: X, text: "text-destructive", tint: "bg-destructive/12" },
	kept: { label: "Kept", icon: Check, text: "text-success", tint: "bg-success/12" },
	warn: {
		label: "Worth knowing",
		icon: TriangleAlert,
		text: "text-warning",
		tint: "bg-warning/12",
	},
	info: { label: "Details", icon: Info, text: "text-muted-foreground", tint: "bg-muted" },
};

/** The effects in card order, grouped by tone; tones with nothing are left out. */
export function groupEffects(
	effects: readonly Effect[],
): { tone: EffectTone; effects: Effect[] }[] {
	return TONE_ORDER.map((tone) => ({
		tone,
		effects: effects.filter((e) => e.tone === tone),
	})).filter((group) => group.effects.length > 0);
}

/** A tone's mark: its icon on a round tint. */
function ToneMark({ tone, className }: { tone: EffectTone; className?: string }) {
	const { icon: Icon, text, tint } = TONES[tone];
	return (
		<span
			aria-hidden
			className={cn("grid size-4 shrink-0 place-items-center rounded-full", tint, text, className)}
		>
			<Icon className="size-2.5" strokeWidth={2.75} />
		</span>
	);
}

/**
 * The effects as a list grouped by what happens to them: each group its mark and name, then what
 * it touches, each with its line of detail.
 */
export function EffectList({ effects }: { effects: readonly Effect[] }) {
	return (
		<div className="space-y-3">
			{groupEffects(effects).map(({ tone, effects: inGroup }) => (
				<section key={tone} aria-label={TONES[tone].label}>
					<h3
						className={cn(
							"flex items-center gap-1.5 font-medium text-[0.6875rem] uppercase tracking-wide",
							TONES[tone].text,
						)}
					>
						<ToneMark tone={tone} />
						{TONES[tone].label}
					</h3>
					<ul className="mt-1 space-y-1 pl-[1.375rem]">
						{inGroup.map((effect, index) => (
							// Effects are fixed lists written in place; their order is their identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above
							<li key={index} className="text-foreground text-sm leading-snug">
								{effect.what}
								{effect.detail && (
									<span className="mt-0.5 block text-muted-foreground text-xs leading-snug">
										{effect.detail}
									</span>
								)}
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

/** The card an explainer opens and an armed confirm button shows: a title, a lead, the effects. */
export function EffectCard({
	title,
	lead,
	effects,
	className,
}: {
	title: ReactNode;
	lead?: ReactNode;
	effects: readonly Effect[];
	className?: string;
}) {
	return (
		<div className={cn("w-80 max-w-[calc(100vw-2rem)]", className)}>
			<div className="border-b px-3.5 pt-3 pb-2.5">
				<p className="font-medium text-foreground text-sm">{title}</p>
				{lead && <p className="mt-0.5 text-muted-foreground text-xs leading-snug">{lead}</p>}
			</div>
			<div className="px-3.5 pt-2.5 pb-3">
				<EffectList effects={effects} />
			</div>
		</div>
	);
}

/** Every tone present, once each, in card order: a glance at what the card holds. */
function ToneMarks({ effects }: { effects: readonly Effect[] }) {
	return (
		<span className="inline-flex shrink-0 items-center -space-x-1">
			{groupEffects(effects).map(({ tone }) => (
				<ToneMark key={tone} tone={tone} className="ring-2 ring-background" />
			))}
		</span>
	);
}

/**
 * A short sentence in place, with the whole story a hover or press away: what an action or setting
 * changes, removes, keeps or sends, grouped in a card. In place of a row of chips or a paragraph.
 */
export function Explainer({
	summary,
	title,
	lead,
	effects,
	className,
}: {
	/** What shows in place: a few words on the gist. */
	summary: ReactNode;
	/** The card's title: the action or setting explained. */
	title: ReactNode;
	/** A sentence under the title, for what the groups do not say. */
	lead?: ReactNode;
	effects: readonly Effect[];
	className?: string;
}) {
	return (
		<Popover openOnHover delay={250} closeDelay={150}>
			<PopoverTrigger
				render={
					<button
						type="button"
						className={cn(
							"inline-flex max-w-full items-center gap-1.5 rounded text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:text-foreground",
							className,
						)}
					/>
				}
			>
				<span className="underline decoration-muted-foreground/40 decoration-dotted underline-offset-[3px]">
					{summary}
				</span>
				<ToneMarks effects={effects} />
			</PopoverTrigger>
			<PopoverPopup
				side="bottom"
				align="start"
				sideOffset={6}
				className="z-50 rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none"
			>
				<EffectCard title={title} lead={lead} effects={effects} />
			</PopoverPopup>
		</Popover>
	);
}
