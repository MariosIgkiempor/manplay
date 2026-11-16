import { ArrowRight, Copy, FolderInput } from "lucide-react";
import type { DropHint } from "#/lib/use-file-drag.tsx";
import { cn } from "#/lib/utils.ts";

const noun = (n: number) => (n === 1 ? "item" : "items");

/** The small label inside a folder row that a drop would land in. */
export function DropChip({ op, className }: { op: "move" | "copy"; className?: string }) {
	const Icon = op === "move" ? FolderInput : Copy;
	return (
		<span
			className={cn(
				"flex shrink-0 items-center gap-1 rounded-md bg-primary px-1.5 py-0.5 font-medium text-[11px] text-primary-foreground shadow-sm [&_svg]:size-3",
				className,
			)}
		>
			<Icon />
			{op === "move" ? "Move here" : "Copy here"}
		</span>
	);
}

/** Floats at the bottom of a pane while a drop could land in it: what happens and where to. */
export function DropHintBar({ hint }: { hint: DropHint | null }) {
	if (hint === null) {
		return null;
	}
	const Icon = hint.op === "move" ? FolderInput : Copy;
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-9 z-10 flex justify-center px-3">
			<div className="flex max-w-full items-center gap-2 rounded-full border border-primary/40 bg-popover/95 py-1.5 pr-3 pl-2.5 text-sm shadow-lg backdrop-blur [&_svg]:size-4 [&_svg]:shrink-0">
				<Icon className="text-primary" />
				<span className="shrink-0 font-medium">
					{hint.op === "move" ? "Move" : "Copy"} {hint.count} {noun(hint.count)}
				</span>
				<ArrowRight className="text-muted-foreground" />
				<span className="min-w-0 truncate text-primary">{hint.into}</span>
			</div>
		</div>
	);
}

/** Classes for a folder row (or the pane background) that is the drop target. */
export const DROP_ROW = "bg-primary/20 ring-1 ring-primary ring-inset";
export const DROP_PANE = "bg-primary/5 ring-2 ring-primary/40 ring-inset";
/** Classes for a row being carried. */
export const CARRIED_ROW = "opacity-40";
