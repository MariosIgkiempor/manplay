import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

/** A bordered group of labelled rows, as used for settings across the app. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("divide-y rounded-lg border px-3", className)}>{children}</div>;
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
