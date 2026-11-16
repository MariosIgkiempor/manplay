import { X } from "lucide-react";
import { cn } from "#/lib/utils.ts";

/** A one-line result under a toolbar: green-ish when it worked, red when something failed. */
export function NoticeBar({
	notice,
	onDismiss,
}: {
	notice: { text: string; failed: boolean } | null;
	onDismiss?: () => void;
}) {
	if (notice === null) {
		return null;
	}
	return (
		<div
			className={cn(
				"flex items-center gap-2 border-b px-3 py-1.5 text-xs",
				notice.failed ? "bg-destructive/10 text-destructive" : "bg-primary/10",
			)}
		>
			<span className="min-w-0 flex-1 break-words">{notice.text}</span>
			{onDismiss && (
				<button
					type="button"
					aria-label="Dismiss"
					onClick={onDismiss}
					className="grid size-5 shrink-0 place-items-center rounded hover:bg-background/60"
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	);
}
