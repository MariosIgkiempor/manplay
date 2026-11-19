import { Link, useMatchRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { CHEVRON, rowBase, rowClass } from "#/components/sidebar-row.ts";
import { compactCount } from "#/lib/format.ts";
import { cn } from "#/lib/utils.ts";

/**
 * A group in the sidebar (Import, Export, Playlists, Tags…): a chevron in the left gutter folding
 * its rows away, its icon and name, and an optional action at the right end, shown on hover. With `to` the name opens that page;
 * without, it folds the group too.
 */
export function GroupHeading({
	label,
	icon,
	open,
	onToggle,
	action,
	to,
}: {
	label: string;
	icon: ReactNode;
	open: boolean;
	onToggle: () => void;
	action?: ReactNode;
	to?: "/import" | "/export";
}) {
	const matchRoute = useMatchRoute();
	const active = to ? !!matchRoute({ to }) : false;
	const inner = (
		<>
			<span className="[&_svg]:size-4">{icon}</span>
			<span className="truncate">{label}</span>
		</>
	);
	return (
		<div className={cn("group/row relative", rowClass(active))}>
			<button
				type="button"
				aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
				aria-expanded={open}
				onClick={onToggle}
				className={CHEVRON}
				style={{ left: 2 }}
			>
				<ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
			</button>
			{to ? (
				<Link to={to} className={rowBase}>
					{inner}
				</Link>
			) : (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					className={cn(rowBase, "text-left outline-none")}
				>
					{inner}
				</button>
			)}
			{action}
		</div>
	);
}

/** The right end of a sidebar row's text: its count or state, in small figures. */
export function RowTrailing({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<span
			className={cn(
				"ml-auto flex h-4 shrink-0 items-center gap-1.5 pl-2 text-[11px] tabular-nums",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** How many songs a row holds, quiet and compact (1.2K). */
export function RowCount({ n, className }: { n: number; className?: string }) {
	return (
		<RowTrailing className={cn("text-muted-foreground/80", className)}>
			{compactCount(n)}
		</RowTrailing>
	);
}

/** A sidebar section's heading, with an optional action (e.g. +) lined up with the row ends. */
export function SectionLabel({ children, action }: { children: string; action?: ReactNode }) {
	return (
		<div className="flex items-center justify-between pt-1 pr-1 pb-1 pl-5">
			<span className="font-medium text-muted-foreground text-xs">{children}</span>
			{action}
		</div>
	);
}
