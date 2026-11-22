import { type ReactNode, useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";
import { DIALOG_BACKDROP, DIALOG_FRAME, WELL } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/** The modal frame: a title, a body and a footer row. Escape or a click outside cancels. */
export function Dialog({
	title,
	children,
	footer,
	onCancel,
}: {
	title: string;
	children?: ReactNode;
	footer: ReactNode;
	onCancel: () => void;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div aria-hidden="true" onMouseDown={onCancel} className={DIALOG_BACKDROP} />
			{/* The question sits in a well; its answers sit on the frame below it. */}
			<div
				role="dialog"
				aria-label={title}
				className={cn(DIALOG_FRAME, "w-[28rem] max-w-[calc(100%-2rem)] p-1")}
			>
				<div className={`${WELL} space-y-1.5 p-4`}>
					<div className="break-words font-medium text-sm">{title}</div>
					{children && <div className="text-pretty text-muted-foreground text-sm">{children}</div>}
				</div>
				<div className="px-2 pt-2 pb-1">{footer}</div>
			</div>
		</div>
	);
}

/** Modal yes/no question. Escape or a click outside cancels. */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	destructive = false,
	busy = false,
	extra,
	onCancel,
	onConfirm,
}: {
	title: string;
	children?: ReactNode;
	confirmLabel: string;
	destructive?: boolean;
	busy?: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	/** A further choice, between Cancel and the confirm button. */
	extra?: ReactNode;
}) {
	return (
		<Dialog
			title={title}
			onCancel={onCancel}
			footer={
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					{extra}
					<Button
						variant={destructive ? "destructive" : "default"}
						onClick={onConfirm}
						disabled={busy}
						autoFocus
					>
						{confirmLabel}
					</Button>
				</div>
			}
		>
			{children}
		</Dialog>
	);
}
