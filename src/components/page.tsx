import type { ReactNode } from "react";
import { typeScale } from "#/lib/type-scale.ts";
import { cn } from "#/lib/utils.ts";

/**
 * A settings-style screen (Import, Export, Metadata, Settings): title, actions on the right, then
 * its sections. No intro prose: what a control does belongs on the control.
 */
export function Page({
	title,
	actions,
	children,
	wide = false,
}: {
	title: string;
	actions?: ReactNode;
	children: ReactNode;
	/** Use the full width, for screens built around one big list. */
	wide?: boolean;
}) {
	return (
		<main className={cn("mx-auto w-full space-y-8 px-6 pt-6 pb-10", !wide && "max-w-5xl")}>
			<header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<h1 className={typeScale.pageTitle}>{title}</h1>
				{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
			</header>
			{children}
		</main>
	);
}

/** A titled part of a screen or panel, with an optional count and action. */
export function Section({
	title,
	count,
	action,
	children,
	className,
}: {
	title: ReactNode;
	count?: number;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("space-y-3", className)}>
			<SectionHeading title={title} count={count} action={action} />
			{children}
		</section>
	);
}

export function SectionHeading({
	title,
	count,
	action,
}: {
	title: ReactNode;
	count?: number | undefined;
	action?: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<h2 className={cn(typeScale.sectionTitle, "flex min-w-0 items-baseline gap-2")}>
				{title}
				{count !== undefined && (
					<span className="font-normal text-muted-foreground tabular-nums">{count}</span>
				)}
			</h2>
			{action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
		</div>
	);
}

/** A bordered surface for a group of settings or a summary. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("rounded-lg border bg-card p-4", className)}>{children}</div>;
}

/** What to show where a list has nothing: what is missing and, when there is one, the way forward. */
export function EmptyState({
	icon,
	title,
	children,
	action,
	className,
}: {
	icon?: ReactNode;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center gap-2 px-4 py-12 text-center [&_svg:not([class*='size-'])]:size-6",
				className,
			)}
		>
			{icon && <div className="mb-1 text-muted-foreground/60">{icon}</div>}
			<p className="font-medium text-sm">{title}</p>
			{children && <p className={cn(typeScale.description, "max-w-sm")}>{children}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}

/** A failed action, in the place it happened. */
export function ErrorLine({ children }: { children: ReactNode }) {
	return <p className="text-destructive text-sm">{children}</p>;
}
