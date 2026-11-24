import type { ReactNode } from "react";
import { Hint } from "#/components/ui/hint.tsx";
import { cn } from "#/lib/utils.ts";

/**
 * A state shown as a small icon beside a name, e.g. "Shared library" or "Off": hovering or
 * focusing it shows what it is and what it means.
 */
export function StatusIcon({
	icon,
	label,
	detail,
	tone = "muted",
	focusable = true,
	className,
}: {
	icon: ReactNode;
	label: string;
	/** One line on what it means. */
	detail?: string;
	tone?: "muted" | "primary";
	/** Takes keyboard focus for its hint; off inside something already focusable. */
	focusable?: boolean;
	className?: string | undefined;
}) {
	return (
		<Hint label={label} detail={detail}>
			<span
				role="img"
				aria-label={label}
				tabIndex={focusable ? 0 : undefined}
				className={cn(
					"inline-grid size-4 shrink-0 place-items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
					tone === "primary" ? "text-primary" : "text-muted-foreground/70",
					className,
				)}
			>
				{icon}
			</span>
		</Hint>
	);
}
