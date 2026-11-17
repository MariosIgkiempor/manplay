import { type ReactNode, useEffect } from "react";
import { Button } from "#/components/ui/button.tsx";

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
			<div
				aria-hidden="true"
				onMouseDown={onCancel}
				className="absolute inset-0 bg-background/60 backdrop-blur-sm"
			/>
			<div
				role="dialog"
				aria-label={title}
				className="relative w-[28rem] max-w-[calc(100%-2rem)] space-y-3 rounded-xl border bg-background p-4 shadow-2xl"
			>
				<div className="break-words font-medium text-sm">{title}</div>
				{children && <div className="text-muted-foreground text-sm">{children}</div>}
				{footer}
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
