import { ArrowLeft, Check, CircleCheck, CircleDashed, RefreshCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { FRAME, WELL_ROWS } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/**
 * The parts every library-problem panel (file issues, duplicates, missing files) is built from,
 * so the three read alike: a bar with what acting on everything would do, then the files in
 * flat cards.
 */

/** What the problem is and what fixing it does, at the top of the panel. */
export function PanelIntro({ children }: { children: ReactNode }) {
	return <p className="text-pretty text-muted-foreground text-sm leading-relaxed">{children}</p>;
}

/** Buttons that act on everything the panel lists, under the intro. */
export function PanelActions({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * The bar pinned to the top of a panel: what acting on everything would do, in a few words, and
 * the buttons that do it. It stays in reach however far the list scrolls.
 */
export function ActionBar({
	summary,
	detail,
	children,
}: {
	summary: ReactNode;
	/** A second, smaller line: what still needs the user, or how to get started. */
	detail?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="sticky -top-5 z-10 -mx-5 -mt-5 flex items-center gap-3 border-hairline border-b bg-canvas/95 px-5 py-2.5 backdrop-blur-sm">
			<div className="min-w-0 flex-1 text-sm">
				<p className="truncate font-medium tabular-nums">{summary}</p>
				{detail !== undefined && (
					<div className="mt-0.5 truncate text-muted-foreground text-xs">{detail}</div>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">{children}</div>
		</div>
	);
}

/** One card of files: a one-line heading (name, a few words, a control), the rows under it. */
export function ProblemList({
	title,
	description,
	action,
	children,
}: {
	title: string;
	/** A few words after the title: a count, or what the card still needs. */
	description?: ReactNode;
	/** A control for the whole card, at the right of its title. */
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		// The app's one card: the title on the frame's lip, the rows in its well.
		<section aria-label={title} className={FRAME}>
			<header className="flex min-h-8 items-center gap-2 px-3 py-1">
				<h2 className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="truncate font-medium text-sm">{title}</span>
					{description !== undefined && (
						<span className="shrink-0 text-muted-foreground text-xs">{description}</span>
					)}
				</h2>
				{action}
			</header>
			<ul className={WELL_ROWS}>{children}</ul>
		</section>
	);
}

/** Shown when there is nothing left to fix: a calm, settled state rather than a blank panel. */
export function ProblemsCleared({ title, children }: { title: string; children: ReactNode }) {
	return (
		<EmptyState icon={<CircleCheck className="text-success" />} title={title}>
			{children}
		</EmptyState>
	);
}

/** A file row's layout in a problem list; the row's own content goes inside. */
export const PROBLEM_ROW =
	"flex items-start gap-3 px-3 py-2.5 transition-colors hover:bg-foreground/[0.02]";

/** A file row's text: its name, where it is, and what is wrong with it as chips. */
export function ProblemText({
	name,
	where,
	hint,
	notes,
}: {
	name: ReactNode;
	where?: ReactNode;
	/** The full path, on hover. */
	hint?: string;
	notes?: readonly { text: ReactNode; tone: "warning" | "muted" | "destructive" }[];
}) {
	return (
		<div className="min-w-0 flex-1 space-y-0.5">
			<div className="truncate font-medium text-sm" data-hint={hint}>
				{name}
			</div>
			{where !== undefined && (
				<div className="truncate text-muted-foreground text-xs" data-hint={hint}>
					{where}
				</div>
			)}
			{notes !== undefined && notes.length > 0 && (
				<div className="flex flex-wrap gap-1 pt-0.5">
					{notes.map((n, i) => (
						<NoteChip
							// biome-ignore lint/suspicious/noArrayIndexKey: notes are fixed per row and never reorder
							key={i}
							tone={n.tone}
						>
							{n.text}
						</NoteChip>
					))}
				</div>
			)}
		</div>
	);
}

/** A short fact about a file, as a small pill: what is wrong with it, or what it holds. */
export function NoteChip({
	tone,
	children,
}: {
	tone: "warning" | "muted" | "destructive";
	children: ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center truncate rounded px-1.5 py-px text-[0.6875rem] leading-4",
				tone === "warning" && "bg-warning/10 text-warning",
				tone === "destructive" && "bg-destructive/10 text-destructive",
				tone === "muted" && "bg-muted text-muted-foreground",
			)}
		>
			{children}
		</span>
	);
}

/**
 * What a bulk action does to one file, as a line of a diff:
 * - `keep`: stays where it is.
 * - `remove`: goes to the Trash.
 * - `change`: is rewritten or moved.
 * - `open`: waits for the user to decide.
 */
export type DiffSide = "keep" | "remove" | "change" | "open";

const DIFF_SIDE: Record<DiffSide, { icon: ReactNode; row: string; mark: string }> = {
	keep: {
		icon: <Check aria-hidden />,
		row: "bg-success/[0.06] shadow-[inset_2px_0_0_var(--success)]",
		mark: "text-success",
	},
	remove: {
		icon: <Trash2 aria-hidden />,
		row: "bg-destructive/[0.06] shadow-[inset_2px_0_0_var(--destructive)]",
		mark: "text-destructive",
	},
	change: {
		icon: <RefreshCw aria-hidden />,
		row: "bg-primary/[0.05] shadow-[inset_2px_0_0_var(--primary)]",
		mark: "text-primary",
	},
	open: {
		icon: <CircleDashed aria-hidden />,
		row: "shadow-[inset_2px_0_0_var(--hairline)]",
		mark: "text-muted-foreground",
	},
};

/**
 * One file in a diff: a coloured rail and mark on the left say what happens to it, the file's
 * words in the middle, `aside` (a size, a button) on the right.
 */
export function DiffLine({
	side,
	label,
	aside,
	hint,
	children,
	className,
}: {
	side: DiffSide;
	/** The side in words, for screen readers: "Keep", "Move to the Trash". */
	label: string;
	/** Why this side, on hovering its mark. */
	hint?: string | undefined;
	aside?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	const look = DIFF_SIDE[side];
	return (
		<div
			className={cn(
				"flex items-start gap-2.5 py-2 pr-3 pl-3 transition-colors motion-reduce:transition-none",
				look.row,
				className,
			)}
		>
			<span
				className={cn("mt-0.5 shrink-0 [&_svg]:size-3.5", look.mark)}
				role="img"
				aria-label={label}
				data-hint={hint}
			>
				{look.icon}
			</span>
			<div className="min-w-0 flex-1">{children}</div>
			{aside !== undefined && <div className="flex shrink-0 items-center gap-1">{aside}</div>}
		</div>
	);
}

/**
 * The last step of a bulk action: what it will do, file by file, with Back and the button that
 * does it pinned to the bottom of the panel so it stays in reach however long the list is.
 */
export function ReviewSheet({
	title,
	summary,
	onBack,
	confirm,
	children,
}: {
	title: string;
	summary: ReactNode;
	onBack: () => void;
	/** The button that carries the action out, usually a `ConfirmButton`. */
	confirm: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className="space-y-4">
			<header className="space-y-1">
				<h2 className="text-balance font-semibold text-lg leading-snug">{title}</h2>
				<p className="text-pretty text-muted-foreground text-sm leading-relaxed">{summary}</p>
			</header>
			<div className="space-y-3">{children}</div>
			<div className="sticky bottom-0 -mx-5 flex items-center gap-2 border-hairline border-t bg-canvas px-5 py-3">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeft />
					Back
				</Button>
				<div className="ml-auto">{confirm}</div>
			</div>
		</section>
	);
}

/** A group of diff lines under a small heading: one song's copies, one folder's files. */
export function DiffGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
	return (
		<div className={FRAME}>
			<div className="truncate px-3 pt-1 pb-1.5 font-medium text-xs">{title}</div>
			<div className={WELL_ROWS}>{children}</div>
		</div>
	);
}

/**
 * A file name with the part that gives it away as a copy (` (1)`, ` - Copy`) struck through, so
 * it is plain why this one goes.
 */
export function MarkedName({
	name,
	marker,
}: {
	name: string;
	marker: { start: number; text: string } | null;
}) {
	if (marker === null) {
		return <span className="block truncate">{name}</span>;
	}
	const end = marker.start + marker.text.length;
	// A long name gives way before its marker does: the marker is the reason this file goes.
	return (
		<span className="flex min-w-0">
			<span className="truncate">{name.slice(0, marker.start)}</span>
			<span className="shrink-0 whitespace-pre">
				<mark className="bg-transparent text-destructive line-through decoration-1 decoration-destructive/60">
					{name.slice(marker.start, end)}
				</mark>
				{name.slice(end)}
			</span>
		</span>
	);
}
