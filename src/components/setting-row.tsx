import type { ReactNode } from "react";
import { FrameSection } from "#/components/frame.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * A group of labelled rows, as used for settings across the app: the rows in a well, inside a
 * frame that carries the group's name when it has one.
 */
export function SettingRows({
	title,
	icon,
	description,
	children,
	className,
}: {
	title?: string | undefined;
	icon?: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<FrameSection
			title={title}
			icon={icon}
			description={description}
			wellClassName={cn("px-4", className)}
		>
			{children}
		</FrameSection>
	);
}

/** A labelled setting: name on the left, control on the right. */
export function SettingRow({
	label,
	title,
	children,
}: {
	label: ReactNode;
	title?: string;
	children: ReactNode;
}) {
	return (
		<div
			className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
			title={title}
		>
			<span className="text-sm">{label}</span>
			<div className="flex flex-wrap items-center gap-1.5">{children}</div>
		</div>
	);
}
