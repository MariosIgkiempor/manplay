import { CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import { FrameSection } from "#/components/frame.tsx";
import { EmptyState } from "#/components/page.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * The parts every library-problem panel (file issues, duplicates, missing files) is built from,
 * so the three read alike: what the problem is, the actions for all of it, then the files in a
 * framed card.
 */

/** What the problem is and what fixing it does, at the top of the panel. */
export function PanelIntro({ children }: { children: ReactNode }) {
	return <p className="text-pretty text-muted-foreground text-sm leading-relaxed">{children}</p>;
}

/** Buttons that act on everything the panel lists, under the intro. */
export function PanelActions({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** One card of files: its name and a sentence on the card's frame, the rows in its well. */
export function ProblemList({
	title,
	description,
	children,
}: {
	title: string;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<FrameSection title={title} description={description}>
			<ul className="divide-y divide-hairline">{children}</ul>
		</FrameSection>
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

/** The three lines of a file row: its name, where it is, and what is wrong with it. */
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
	notes?: readonly { text: ReactNode; tone: "warning" | "muted" }[];
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
			{notes?.map((n, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: notes are fixed per row and never reorder
					key={i}
					className={cn("text-xs", n.tone === "warning" ? "text-warning" : "text-muted-foreground")}
				>
					{n.text}
				</div>
			))}
		</div>
	);
}
