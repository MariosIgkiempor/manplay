import { ArrowLeft, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { AddDestinationPanel } from "#/components/add-destination-panel.tsx";
import { AlbumPanel } from "#/components/album-panel.tsx";
import { ArtistPanel } from "#/components/artist-panel.tsx";
import { DownloadsPanel } from "#/components/downloads-source.tsx";
import { EditTagsPanel } from "#/components/edit-tags-panel.tsx";
import { GridEditorPanel } from "#/components/grid-editor.tsx";
import { ItunesPanel } from "#/components/itunes-source.tsx";
import { RekordboxPanel } from "#/components/rekordbox-source.tsx";
import { TargetPanel } from "#/components/target-detail.tsx";
import { Button } from "#/components/ui/button.tsx";
import { UsbDrivePanel } from "#/components/usb-drives.tsx";
import { ValuePanel } from "#/components/value-panel.tsx";
import {
	type DetailView,
	PanelScopeContext,
	StatusSlotContext,
	useDetail,
} from "#/context/detail-context.ts";
import type { ServiceId } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

/** Services with a panel of their own; export folders, buckets and drives open one each. */
const SERVICE_PANELS: Partial<Record<ServiceId, () => ReactNode>> = {
	downloads: DownloadsPanel,
	itunes: ItunesPanel,
	rekordbox: RekordboxPanel,
};

function Content({ view }: { view: DetailView }) {
	switch (view.kind) {
		case "album":
			return <AlbumPanel albumKey={view.key} />;
		case "artist":
			return <ArtistPanel name={view.name} />;
		case "service": {
			const Panel = SERVICE_PANELS[view.service];
			return Panel ? <Panel /> : null;
		}
		case "target":
			return <TargetPanel id={view.id} />;
		case "usb":
			return <UsbDrivePanel mount={view.mount} />;
		case "grid":
			return <GridEditorPanel trackId={view.trackId} list={view.list} />;
		case "add-destination":
			return <AddDestinationPanel service={view.service} />;
		case "value":
			return <ValuePanel field={view.field} value={view.value} />;
		case "edit":
			return <EditTagsPanel target={view.target} fromAlbum={view.fromAlbum ?? false} />;
		default:
			return null;
	}
}

function isTyping(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Right-hand slide-over for album / artist details, over a blurred backdrop; clicking the backdrop or pressing Escape closes it. */
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
			if (
				e.key === "Escape" &&
				view &&
				!isTyping(e.target) &&
				!document.querySelector("[role=dialog]")
			) {
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
					"absolute inset-y-0 right-0 z-20 flex max-w-full flex-col border-l bg-background shadow-2xl transition-[translate,width] duration-200",
					// A drive's library browser and the grid editor need room for its playlists beside their songs.
					shown?.kind === "usb" || shown?.kind === "grid" ? "w-[60rem]" : "w-[36rem]",
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
							<detail.UnsavedScope>{shown && <Content view={shown} />}</detail.UnsavedScope>
						</StatusSlotContext.Provider>
					</PanelScopeContext.Provider>
				</div>
				<div ref={setStatusSlot} className="absolute inset-x-0 bottom-0" />
			</aside>
		</>
	);
}
