import { CircleCheck, CircleDashed, CloudUpload } from "lucide-react";
import type { SyncState } from "#/lib/albums.ts";
import { cn } from "#/lib/utils.ts";

const META = {
	synced: { label: "Synced", Icon: CircleCheck, className: "text-emerald-500" },
	partial: { label: "Partly synced", Icon: CircleDashed, className: "text-amber-500" },
	pending: { label: "Not synced yet", Icon: CloudUpload, className: "text-muted-foreground" },
} as const;

interface Props {
	state: SyncState;
	/** Show the text label next to the icon. */
	showLabel?: boolean;
	className?: string;
}

export function SyncBadge({ state, showLabel = false, className }: Props) {
	if (state === "none") {
		return null;
	}
	const { label, Icon, className: tone } = META[state];
	return (
		<span
			title={label}
			role="img"
			aria-label={label}
			className={cn("inline-flex items-center gap-1 text-xs", tone, className)}
		>
			<Icon className="size-4" />
			{showLabel && <span>{label}</span>}
		</span>
	);
}
