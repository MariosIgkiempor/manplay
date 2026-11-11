import { ArrowLeft, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { AlbumPanel } from "#/components/album-panel.tsx";
import { ArtistPanel } from "#/components/artist-panel.tsx";
import { TagPanel } from "#/components/tag-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	type DetailView,
	PanelScopeContext,
	StatusSlotContext,
	useDetail,
} from "#/context/detail-context.ts";
import { cn } from "#/lib/utils.ts";

function Content({ view }: { view: DetailView }) {
	switch (view.kind) {
		case "album":
			return <AlbumPanel albumKey={view.key} />;
		case "artist":
			return <ArtistPanel name={view.name} />;
		case "tag":
			return <TagPanel name={view.name} />;
		default:
			return null;
	}
}

function isTyping(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Right-hand slide-over for album / artist / tag details, over a blurred backdrop; clicking the backdrop or pressing Escape closes it. */
export function DetailPanel(): ReactNode {
	const detail = useDetail();
	// Keep the last view mounted while the panel slides out.
	const [last, setLast] = useState<DetailView | null>(null);
	const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
	const { view, close } = detail;

	useEffect(() => {
		if (view) {
			setLast(view);
		}
	}, [view]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && view && !isTyping(e.target)) {
				close();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [view, close]);

	const shown = view ?? last;
	const open = view !== null;

	return (
		<>
			<div
				aria-hidden="true"
				onClick={close}
				className={cn(
					"absolute inset-0 z-10 bg-background/40 backdrop-blur-sm transition-opacity duration-200",
					open ? "opacity-100" : "pointer-events-none opacity-0",
				)}
			/>
			<aside
				aria-label="Details"
				inert={!open}
				className={cn(
					"absolute inset-y-0 right-0 z-20 flex w-[36rem] max-w-full flex-col border-l bg-background shadow-2xl transition-transform duration-200",
					open ? "translate-x-0" : "translate-x-full",
				)}
			>
				<div className="flex items-center justify-between border-b px-3 py-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={detail.back}
						disabled={!detail.canGoBack}
						className={detail.canGoBack ? "" : "invisible"}
					>
						<ArrowLeft /> Back
					</Button>
					<Button variant="ghost" size="icon" aria-label="Close panel" onClick={detail.close}>
						<X />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5">
					<PanelScopeContext.Provider value>
						<StatusSlotContext.Provider value={statusSlot}>
							{shown && <Content view={shown} />}
						</StatusSlotContext.Provider>
					</PanelScopeContext.Provider>
				</div>
				<div ref={setStatusSlot} className="absolute inset-x-0 bottom-0" />
			</aside>
		</>
	);
}
