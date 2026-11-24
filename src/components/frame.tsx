import type { ReactNode } from "react";
import { FRAME, WELL, WELL_ROWS } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/**
 * The bezel every framed screen is built from: an outer frame that names a group, and a well set
 * into it that holds the group's rows. The well is inset by a few pixels on every side, so the
 * frame shows as a thin lip around it, the way a code block sits in its file tab.
 */

/** A framed group: its name and what it is for on the frame, its rows in the well below. */
export function FrameSection({
	title,
	titleHidden = false,
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
	/** Name the group for screen readers only, where a tab or heading above already says it. */
	titleHidden?: boolean;
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
			{title !== undefined && titleHidden && (Boolean(description) || Boolean(action)) && (
				<div className="flex items-center gap-4 px-4 pt-2 pb-2">
					<p className="min-w-0 flex-1 text-pretty text-muted-foreground text-sm">{description}</p>
					{action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
				</div>
			)}
			{title !== undefined && !titleHidden && (
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

/**
 * The app's one container: a frame's thin lip round a well. Every list, every empty or failed
 * state and every group of settings sits in one, on pages, in the side panel and in the cards
 * that float over them, so anything that holds content looks the same. `rows` splits the well's
 * direct children with hairlines, for a list.
 */
export function WellCard({
	children,
	rows = false,
	className,
	wellClassName,
}: {
	children: ReactNode;
	rows?: boolean;
	/** For the frame: its place and size in the layout. */
	className?: string | undefined;
	/** For the well: its padding and scrolling. */
	wellClassName?: string | undefined;
}) {
	return (
		<div className={cn(FRAME, className)}>
			<div className={cn(rows ? WELL_ROWS : WELL, wellClassName)}>{children}</div>
		</div>
	);
}
