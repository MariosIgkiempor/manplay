import type { ReactNode } from "react";
import { FRAME, WELL_ROWS } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/**
 * The bezel every framed screen is built from: an outer frame that names a group, and a well set
 * into it that holds the group's rows. The well is inset by a few pixels on every side, so the
 * frame shows as a thin lip around it, the way a code block sits in its file tab.
 */

/** A page header on the frame's top edge: title and figures on one line, buttons right, tabs under. */
export function FrameHeader({
	title,
	titleHint,
	meta,
	actions,
	tabs,
	continued = false,
}: {
	title: string;
	/** Hover text for the title, e.g. where the library is on disk. */
	titleHint?: string | undefined;
	meta?: ReactNode;
	actions?: ReactNode;
	tabs?: ReactNode;
	/** A sticky bar right under it carries on the header (its tabs), so it ends without a rule. */
	continued?: boolean;
}) {
	const hasTabs = tabs !== undefined && tabs !== null && tabs !== false;
	return (
		<header
			className={cn(
				"px-6 pt-5",
				!continued && "border-hairline border-b",
				hasTabs || continued ? "pb-0" : "pb-4",
			)}
		>
			<div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 basis-60 items-baseline gap-3">
					<h1 className="truncate font-semibold text-lg tracking-tight" title={titleHint ?? title}>
						{title}
					</h1>
					{meta && (
						<p className="flex min-w-0 shrink-0 items-baseline gap-3 text-muted-foreground text-sm tabular-nums">
							{meta}
						</p>
					)}
				</div>
				{actions !== undefined && actions !== null && (
					<div className="flex shrink-0 items-center gap-2">{actions}</div>
				)}
			</div>
			{hasTabs && <div className="-mb-px mt-3">{tabs}</div>}
		</header>
	);
}

/** A framed group: its name and what it is for on the frame, its rows in the well below. */
export function FrameSection({
	title,
	icon,
	count,
	description,
	action,
	children,
	className,
	wellClassName,
}: {
	/** Without one, the frame is a thin lip round the well. */
	title?: string | undefined;
	/** A mark before the title, e.g. the logo of the service the group sets up. */
	icon?: ReactNode;
	/** How many the group holds, quietly after its title. */
	count?: number | undefined;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	wellClassName?: string;
}) {
	return (
		<section aria-label={title} className={cn(FRAME, className)}>
			{title !== undefined && (
				<div className="flex items-start gap-4 px-4 pt-3 pb-3">
					<div className="min-w-0 flex-1">
						<h2 className="flex items-center gap-2 font-medium text-[0.9375rem]">
							{icon}
							{title}
							{count !== undefined && (
								<span className="font-normal text-muted-foreground tabular-nums">
									{count.toLocaleString()}
								</span>
							)}
						</h2>
						{description && (
							<p className="mt-0.5 max-w-prose text-pretty text-muted-foreground text-sm">
								{description}
							</p>
						)}
					</div>
					{action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
				</div>
			)}
			<FrameWell className={wellClassName}>{children}</FrameWell>
		</section>
	);
}

/** The inset surface of a frame. Its direct children are rows, split by hairlines. */
export function FrameWell({
	children,
	className,
}: {
	children: ReactNode;
	className?: string | undefined;
}) {
	return <div className={cn(WELL_ROWS, className)}>{children}</div>;
}

/**
 * One setting in a well: its name and a sentence on what it does on the left, the control on the
 * right. In a narrow window the control drops under the words.
 */
export function FieldRow({
	label,
	description,
	htmlFor,
	children,
	align = "start",
}: {
	label: ReactNode;
	description?: ReactNode;
	/** The id of the control, so a click on the name reaches it. */
	htmlFor?: string | undefined;
	children?: ReactNode;
	/** Centre the control against the words, for a lone switch or button. */
	align?: "start" | "center";
}) {
	const Label = htmlFor ? "label" : "p";
	return (
		<div
			className={cn(
				"grid gap-x-8 gap-y-3 px-4 py-4 @2xl/main:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]",
				align === "center" && "items-center",
			)}
		>
			<div className="min-w-0">
				<Label htmlFor={htmlFor} className="block font-medium text-sm">
					{label}
				</Label>
				{description && (
					<div className="mt-1 max-w-prose text-pretty text-muted-foreground text-[0.8125rem] leading-relaxed">
						{description}
					</div>
				)}
			</div>
			{children && (
				<div className="flex min-w-0 flex-wrap items-center gap-2 @2xl/main:justify-end">
					{children}
				</div>
			)}
		</div>
	);
}

/**
 * A page's tabs and its search in one bar under a `continued` header, sticking while the page
 * scrolls. Tabs that do not fit scroll sideways; `below` adds a row under both, e.g. what to do
 * with a selection.
 */
export function TabsSearchBar({
	tabs,
	search,
	below,
}: {
	tabs: ReactNode;
	search: ReactNode;
	below?: ReactNode;
}) {
	return (
		<div className="sticky top-0 z-10 border-hairline border-b bg-background px-6">
			<div className="flex items-stretch gap-4 pt-3">
				<div className="min-w-0 overflow-x-auto no-scrollbar">{tabs}</div>
				<div className="ml-auto flex min-w-64 max-w-md flex-1 items-center pb-1.5">{search}</div>
			</div>
			{below && <div className="pb-2">{below}</div>}
		</div>
	);
}

/** A frame's lip round content that brings its own well, such as a list with a toolbar in it. */
export function Framed({
	children,
	className,
}: {
	children: ReactNode;
	className?: string | undefined;
}) {
	return <div className={cn(FRAME, className)}>{children}</div>;
}
