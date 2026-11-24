import {
	ArrowUpRight,
	Check,
	ChevronRight,
	Info,
	type LucideIcon,
	RefreshCw,
	TriangleAlert,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * What a fact says about the thing it sits beside:
 * - `kept`: stays as it is (green check).
 * - `lost`: is removed or cleared (red cross).
 * - `changed`: is rewritten or redone (accent arrows).
 * - `sent`: leaves this computer (amber arrow out).
 * - `warn`: worth knowing before going on (amber triangle).
 * - `info`: plain detail (grey).
 */
export type FactTone = "kept" | "lost" | "changed" | "sent" | "warn" | "info";

const TONES: Record<FactTone, { icon: LucideIcon | null; className: string }> = {
	kept: { icon: Check, className: "[&_svg]:text-success" },
	lost: { icon: X, className: "[&_svg]:text-destructive" },
	changed: { icon: RefreshCw, className: "[&_svg]:text-primary" },
	sent: { icon: ArrowUpRight, className: "[&_svg]:text-warning" },
	warn: { icon: TriangleAlert, className: "[&_svg]:text-warning" },
	info: { icon: null, className: "" },
};

/**
 * One short fact: a word or two of quiet text behind a small mark coloured by what it means, so
 * it reads as a note and not as a status or a button. `hint` carries the longer explanation on
 * hover, so nothing is lost by keeping it short.
 */
export function Fact({
	tone = "info",
	icon,
	hint,
	children,
}: {
	tone?: FactTone;
	/** Replaces the tone's own mark, e.g. the icon of the thing named. */
	icon?: ReactNode;
	hint?: string;
	children: ReactNode;
}) {
	const { icon: ToneIcon, className } = TONES[tone];
	return (
		<span
			data-hint={hint}
			className={cn(
				"inline-flex h-5 items-center gap-1 whitespace-nowrap text-muted-foreground text-xs [&_svg]:size-3 [&_svg]:shrink-0",
				className,
			)}
		>
			{icon ?? (ToneIcon && <ToneIcon aria-hidden />)}
			{children}
		</span>
	);
}

/**
 * A row of facts in place of a sentence. `label` reads the row for screen readers and on hover,
 * e.g. the sentence the facts replace.
 */
export function Facts({
	label,
	children,
	className,
}: {
	label?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			{...(label === undefined ? {} : { "aria-label": label, "data-hint": label })}
			className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-0.5", className)}
		>
			{children}
		</span>
	);
}

/** A place in another app's menus, e.g. Settings › Advanced › Database, as chips. */
export function UiPath({ parts }: { parts: readonly string[] }) {
	return (
		<span className="inline-flex flex-wrap items-center gap-0.5 align-middle">
			{parts.map((part, index) => (
				<span key={part} className="inline-flex items-center gap-0.5">
					{index > 0 && <ChevronRight aria-hidden className="size-3 text-muted-foreground" />}
					<kbd className="rounded border bg-muted px-1.5 font-sans text-foreground text-xs">
						{part}
					</kbd>
				</span>
			))}
		</span>
	);
}

/** An ⓘ that holds a longer explanation on hover, for detail that a chip cannot carry. */
export function MoreInfo({ hint }: { hint: string }) {
	return (
		<span
			role="img"
			aria-label={hint}
			data-hint={hint}
			className="inline-flex align-middle text-muted-foreground hover:text-foreground"
		>
			<Info className="size-3.5" />
		</span>
	);
}
