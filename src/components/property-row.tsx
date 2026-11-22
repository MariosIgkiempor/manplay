import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * One property as a single row: its name on the left, the value or controls beside it, and an
 * optional action at the end. Shared by the metadata editor and the beat grid settings.
 */
export function PropertyRow({
	label,
	children,
	end,
	title,
	className,
}: {
	label: ReactNode;
	children: ReactNode;
	/** A small action at the row's end, e.g. undo. */
	end?: ReactNode;
	title?: string;
	className?: string;
}) {
	return (
		<div
			data-hint={title}
			className={cn(
				"group/field grid min-h-8 grid-cols-[7rem_minmax(0,1fr)_1.5rem] items-center gap-2",
				className,
			)}
		>
			<div className="flex min-w-0 items-center gap-1">{label}</div>
			<div className="min-w-0">{children}</div>
			<div className="flex justify-end">{end}</div>
		</div>
	);
}

/** A run of small buttons inside one quiet outline, for related steps (½× 2× Tap). */
export function ButtonGroup({ children }: { children: ReactNode }) {
	return (
		<div className="inline-flex rounded-lg border border-input p-0.5 dark:bg-input/30">
			{children}
		</div>
	);
}

export function GroupButton({
	children,
	onClick,
	title,
	label,
	active = false,
	disabled = false,
}: {
	children: ReactNode;
	onClick: (e: React.MouseEvent) => void;
	title?: string;
	label?: string;
	active?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			data-hint={title}
			aria-label={label}
			aria-pressed={active ? true : undefined}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex h-6 items-center gap-1 rounded-md px-2 text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5",
				active
					? "bg-primary/20 text-primary"
					: "text-muted-foreground hover:bg-muted hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}
