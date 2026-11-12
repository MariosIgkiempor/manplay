import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { cn } from "#/lib/utils.ts";

/** Open drawers, innermost last, so Escape closes only the top one. */
const openStack: string[] = [];

/**
 * Slide-over stacked inside the nearest positioned ancestor (the details panel or another drawer).
 * Clicking the backdrop or pressing Escape closes it.
 */
export function Drawer({
	open,
	onClose,
	title,
	width = "w-[30rem]",
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	width?: string;
	children: ReactNode;
}) {
	const id = useId();
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
			if (e.key === "Escape" && openStack.at(-1) === id) {
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
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="truncate pl-2 font-medium text-sm">{title}</span>
					<Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
						<X />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">{open ? children : last}</div>
			</aside>
		</>
	);
}
