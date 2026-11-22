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
					"absolute inset-0 z-30 bg-canvas/50 backdrop-blur-[2px] transition-opacity duration-200",
					open ? "opacity-100" : "pointer-events-none opacity-0",
				)}
			/>
			<aside
				aria-label={title}
				inert={!open}
				className={cn(
					"absolute inset-y-0 right-0 z-40 flex max-w-[calc(100%-2rem)] flex-col border-hairline border-l bg-background transition-transform duration-250 ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-none",
					width,
					// A closed drawer waits just outside the edge: its shadow must not bleed back in.
					open ? "translate-x-0 shadow-2xl" : "translate-x-full",
				)}
			>
				{header !== undefined ? (
					<div className="relative border-hairline border-b px-4 pt-4">
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
					<div className="flex items-center justify-between border-hairline border-b px-3 py-2">
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
