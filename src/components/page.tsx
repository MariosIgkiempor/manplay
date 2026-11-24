import {
	CircleCheck,
	CircleSlash,
	Inbox,
	LoaderCircle,
	RefreshCw,
	SearchX,
	TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { WellCard } from "#/components/frame.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import { openPrivacySettings } from "#/lib/api.ts";
import { describeError } from "#/lib/errors.ts";
import { PAGE_BODY } from "#/lib/page-layout.ts";
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
	return <WellCard wellClassName={cn("p-4", className)}>{children}</WellCard>;
}

/**
 * Why a place shows nothing, which picks its mark when the caller gives none:
 * - `empty`: nothing here yet.
 * - `search`: things exist, none match the search or filter.
 * - `gone`: the thing this page was about no longer exists.
 * - `loading`: still being read.
 * - `done`: nothing left to do, which is good news.
 */
export type EmptyKind = "empty" | "search" | "gone" | "loading" | "done";

const EMPTY_ICON: Record<EmptyKind, ReactNode> = {
	empty: <Inbox />,
	search: <SearchX />,
	gone: <CircleSlash />,
	loading: <LoaderCircle className="animate-spin motion-reduce:animate-none" />,
	done: <CircleCheck className="text-success" />,
};

/**
 * What to show where a page, panel or list has nothing: always the same shape, a mark, what is
 * missing in a few words, one plain sentence, and the way forward when there is one, in the app's
 * one card (`WellCard`).
 */
export function EmptyState({
	kind = "empty",
	icon,
	title,
	children,
	action,
	bare = false,
	className,
}: {
	kind?: EmptyKind;
	/** A mark of the thing itself, in place of the kind's own. */
	icon?: ReactNode;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
	/** Already inside a well (a list's own, a popup's): no card of its own. */
	bare?: boolean;
	className?: string | undefined;
}) {
	const body = (
		<div
			role={kind === "loading" ? "status" : undefined}
			className={cn("flex flex-col items-center gap-2 px-4 py-12 text-center", bare && className)}
		>
			<div className="mb-1 text-muted-foreground/60 [&_svg:not([class*='size-'])]:size-6">
				{icon ?? EMPTY_ICON[kind]}
			</div>
			<p className="font-medium text-sm">{title}</p>
			{children && <p className={cn(typeScale.description, "max-w-sm")}>{children}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
	// In the same card as the list it stands in for, so a page keeps its shape when it is empty.
	return bare ? body : <WellCard className={cn("w-full", className)}>{body}</WellCard>;
}

/**
 * A page or step that could not be shown at all because reading it failed: the same shape as an
 * empty state, saying what went wrong in plain words (`describeError`), with Try again and any
 * other way on. A failed action on a page that does show uses `ErrorLine`, at the top of the page.
 */
export function ErrorState({
	error,
	onRetry,
	action,
	className,
}: {
	error: string;
	onRetry?: (() => void) | undefined;
	/** Another way on, after Try again, e.g. Skip. */
	action?: ReactNode;
	className?: string;
}) {
	const { title, detail } = describeError(error);
	return (
		<div role="alert" data-hint={error}>
			<EmptyState
				icon={<TriangleAlert className="text-destructive" />}
				title={typeof title === "string" ? title : "This could not be read"}
				className={className}
				action={
					(onRetry ?? action) && (
						<div className="flex items-center gap-2">
							{onRetry && (
								<Button size="sm" onClick={onRetry}>
									<RefreshCw /> Try again
								</Button>
							)}
							{action}
						</div>
					)
				}
			>
				{detail}
			</EmptyState>
		</div>
	);
}

/** A panel whose thing is still being read, or is no longer in the library. */
export function NotThere({ what, pending }: { what: string; pending: boolean }) {
	return pending ? (
		<EmptyState kind="loading" title={`Loading ${what}…`} />
	) : (
		<EmptyState kind="gone" title={`${what.charAt(0).toUpperCase()}${what.slice(1)} not found`} />
	);
}

/** Nothing to list inside a menu, a picker or a tab of a panel: one quiet line, the same everywhere. */
export function EmptyLine({ children, className }: { children: ReactNode; className?: string }) {
	return <p className={cn("px-3 py-2 text-muted-foreground text-sm", className)}>{children}</p>;
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
	className?: string | undefined;
}) {
	const raw = typeof children === "string" ? children : null;
	const { title, detail } = raw === null ? { title: children, detail: null } : describeError(raw);
	const blockedByMacOs = raw?.includes(MACOS_BLOCKED_ACCESS) ?? false;
	return (
		<div
			role="alert"
			data-hint={compact && raw !== null ? raw : undefined}
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
