import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/**
 * Buttons joined into one segmented control: one outline, hairlines between them. Buttons that
 * are its children (or a component's top-level button) take the group's shape; the primary one
 * keeps its fill. The rules are in styles.css, so buttons in a drawer a segment opens are left alone.
 */
export function ButtonGroup({
	children,
	size = "default",
	className,
}: {
	children: ReactNode;
	/** "sm" for panels, matching their smaller type. */
	size?: "default" | "sm";
	className?: string;
}) {
	return (
		<div
			data-slot="button-group"
			data-size={size}
			className={cn(
				"inline-flex shrink-0 items-stretch overflow-clip rounded-lg border border-input bg-background dark:bg-input/30",
				className,
			)}
		>
			{children}
		</div>
	);
}
