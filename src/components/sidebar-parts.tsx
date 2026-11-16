import { Link, useMatchRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { rowBase, rowClass } from "#/components/sidebar-row.ts";
import { cn } from "#/lib/utils.ts";

/**
 * A group in the sidebar (Import, Export, Playlists, Tags…): its icon and name, an optional
 * action shown on hover, and a chevron folding its rows away. With `to` the name opens that page;
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
			<button
				type="button"
				aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
				aria-expanded={open}
				onClick={onToggle}
				className="grid size-5 shrink-0 place-items-center rounded hover:bg-background/60"
			>
				<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
			</button>
		</div>
	);
}

/** Right-aligned song count. */
export function RowCount({ n, className }: { n: number; className?: string }) {
	return <span className={cn("ml-auto pl-2 text-xs tabular-nums", className)}>{n}</span>;
}

/** A sidebar section's heading, with an optional action (e.g. +) lined up with the row ends. */
export function SectionLabel({ children, action }: { children: string; action?: ReactNode }) {
	return (
		<div className="flex items-center justify-between pt-1 pr-1 pb-1 pl-2">
			<span className="font-medium text-muted-foreground text-xs">{children}</span>
			{action}
		</div>
	);
}
