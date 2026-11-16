import { X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { useUnsavedGuard } from "#/lib/unsaved.tsx";
import { cn } from "#/lib/utils.ts";

/** Open drawers, innermost last, so Escape closes only the top one. */
const openStack: string[] = [];

/**
 * Slide-over stacked inside the nearest positioned ancestor (the details panel or another drawer).
 * Clicking the backdrop or pressing Escape closes it, once its unsaved changes are saved or
 * confirmed (see `useUnsaved`).
 */
export function Drawer({
	open,
	onClose: close,
	title,
	width = "w-[30rem]",
	header,
	bare = false,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	width?: string;
	/** Replaces the title bar with a fixed header of its own, such as a page header with tabs. */
	header?: ReactNode;
	/** The content has no padding and does its own scrolling, to pin a footer under it. */
	bare?: boolean;
	children: ReactNode;
}) {
	const id = useId();
	const { guard, dialog, Provider } = useUnsavedGuard();
	const onClose = useCallback(() => void guard(close), [guard, close]);
	// Keep the last content mounted while the drawer slides out.
	const [last, setLast] = useState<ReactNode>(null);
	useEffect(() => {
		if (open) {
			setLast(children);
		}
	}, [open, children]);
	useEffect(() => {
		if (!open) {
			return;
		}
		openStack.push(id);
		const onKey = (e: KeyboardEvent) => {
			if (
				e.key === "Escape" &&
				openStack.at(-1) === id &&
				!document.querySelector("[role=dialog]")
			) {
				e.stopPropagation();
				onClose();
			}
		};
		// Capture phase so this runs before the parent panel's own Escape handler.
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			const at = openStack.indexOf(id);
			if (at >= 0) {
				openStack.splice(at, 1);
			}
		};
	}, [open, id, onClose]);

	return (
		<>
			<div
				aria-hidden="true"
				onClick={onClose}
				className={cn(
					"absolute inset-0 z-30 bg-background/40 backdrop-blur-sm transition-opacity duration-200",
					open ? "opacity-100" : "pointer-events-none opacity-0",
				)}
			/>
			<aside
				aria-label={title}
				inert={!open}
				className={cn(
					"absolute inset-y-0 right-0 z-40 flex max-w-[calc(100%-2rem)] flex-col border-l bg-background shadow-2xl transition-transform duration-200",
					width,
					open ? "translate-x-0" : "translate-x-full",
				)}
			>
				{header !== undefined ? (
					<div className="relative border-b bg-card/40 px-4 pt-4">
						{header}
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close"
							onClick={onClose}
							className="absolute top-2 right-2"
						>
							<X />
						</Button>
					</div>
				) : (
					<div className="flex items-center justify-between border-b px-3 py-2">
						<span className="truncate pl-2 font-medium text-sm">{title}</span>
						<Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
							<X />
						</Button>
					</div>
				)}
				<div className={cn("min-h-0 flex-1", !bare && "overflow-y-auto p-4")}>
					<Provider>{open ? children : last}</Provider>
				</div>
			</aside>
			{dialog}
		</>
	);
}
