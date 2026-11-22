import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "#/components/page-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import { openPrivacySettings } from "#/lib/api.ts";
import { describeError } from "#/lib/errors.ts";
import { PAGE_BODY, WELL } from "#/lib/page-layout.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { cn } from "#/lib/utils.ts";

/**
 * A page with the shared header (title, figures, buttons, optional tabs) and its sections
 * below. No intro prose: what a control does belongs on the control.
 */
export function Page({
	title,
	meta,
	actions,
	tabs,
	children,
	wide = false,
}: {
	title: string;
	meta?: ReactNode;
	actions?: ReactNode;
	tabs?: ReactNode;
	children: ReactNode;
	/** Use the full width, for screens built around one big list. */
	wide?: boolean;
}) {
	return (
		<main>
			<PageHeader title={title} meta={meta} actions={actions} tabs={tabs} />
			<div className={cn("w-full space-y-8", PAGE_BODY, !wide && "max-w-5xl")}>{children}</div>
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
	return <div className={cn(WELL, "p-4", className)}>{children}</div>;
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
		<div className={cn("flex flex-col items-center gap-2 px-4 py-12 text-center", className)}>
			{icon && (
				<div className="mb-1 text-muted-foreground/60 [&_svg:not([class*='size-'])]:size-6">
					{icon}
				</div>
			)}
			<p className="font-medium text-sm">{title}</p>
			{children && <p className={cn(typeScale.description, "max-w-sm")}>{children}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}

/** Start of the backend's message when macOS privacy settings block a folder. */
const MACOS_BLOCKED_ACCESS = "macOS blocked access";

/**
 * A failed action, in the place it happened: what went wrong in plain words, then what to do.
 * Text children are rewritten by `describeError`; `compact` keeps one line for rows and tables,
 * with the full message on hover.
 */
export function ErrorLine({
	children,
	compact = false,
	className,
}: {
	children: ReactNode;
	compact?: boolean;
	className?: string;
}) {
	const raw = typeof children === "string" ? children : null;
	const { title, detail } = raw === null ? { title: children, detail: null } : describeError(raw);
	const blockedByMacOs = raw?.includes(MACOS_BLOCKED_ACCESS) ?? false;
	return (
		<div
			role="alert"
			title={compact && raw !== null ? raw : undefined}
			className={cn("flex min-w-0 items-start gap-2 text-destructive", className)}
		>
			<TriangleAlert className="mt-0.5 size-4 shrink-0" />
			<div className="min-w-0 space-y-0.5">
				<p className={cn("break-words text-sm", !compact && "font-medium", compact && "truncate")}>
					{title}
				</p>
				{!compact && detail && (
					<p className="break-words text-muted-foreground text-xs">{detail}</p>
				)}
				{!compact && blockedByMacOs && (
					<Button
						variant="outline"
						size="sm"
						className="mt-2"
						onClick={() => openPrivacySettings()}
					>
						Open Privacy Settings
					</Button>
				)}
			</div>
		</div>
	);
}

/** Something is being fetched or worked on. Say what, in the present tense. */
export function LoadingLine({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<output className={cn("flex items-center gap-2 text-muted-foreground text-sm", className)}>
			<LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
			{children}
		</output>
	);
}
