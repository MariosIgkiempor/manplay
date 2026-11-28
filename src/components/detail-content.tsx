import type { ReactNode } from "react";
import { AlbumPanel } from "#/components/album-panel.tsx";
import { ArtistPanel } from "#/components/artist-panel.tsx";
import { DuplicatesPanel } from "#/components/duplicates.tsx";
import { EditTagsPanel } from "#/components/edit-tags-panel.tsx";
import { IssuesPanel } from "#/components/issues-drawer.tsx";
import { MissingPanel } from "#/components/missing-files.tsx";
import { SongPanel } from "#/components/song-panel.tsx";
import { UsbExportPanel } from "#/components/usb-export.tsx";
import { ValuePanel } from "#/components/value-panel.tsx";
import { type DetailView, PanelScopeContext, useDetail } from "#/context/detail-context.ts";
import { PanelBarContext, type PanelBarSlots } from "#/context/panel-bar.tsx";
import { StatusScopeContext } from "#/context/status-context.ts";
import { detailViewKey } from "#/lib/detail-views.ts";

function Content({ view }: { view: DetailView }) {
	switch (view.kind) {
		case "song":
			return <SongPanel trackId={view.trackId} list={view.list} />;
		case "album":
			return <AlbumPanel albumKey={view.key} />;
		case "artist":
			return <ArtistPanel name={view.name} />;
		case "value":
			return <ValuePanel field={view.field} value={view.value} />;
		case "edit":
			return <EditTagsPanel target={view.target} />;
		case "missing":
			return <MissingPanel />;
		case "issues":
			return <IssuesPanel />;
		case "duplicates":
			return <DuplicatesPanel />;
		case "usbExport":
			return <UsbExportPanel mount={view.mount} />;
	}
}

/**
 * A view's content, in a card or the side panel: `slots` are the places in the top bar where it
 * puts its title and buttons. Its unsaved changes are saved or asked about on leaving.
 */
export function DetailBody({ view, slots }: { view: DetailView; slots: PanelBarSlots }): ReactNode {
	const { UnsavedScope } = useDetail();
	return (
		<PanelBarContext.Provider value={slots}>
			<PanelScopeContext.Provider value>
				<StatusScopeContext.Provider value="panel">
					<UnsavedScope>
						{/* Each new thing eases in; switching a song's tab does not. */}
						<div key={detailViewKey(view)} className="fold-in">
							<Content view={view} />
						</div>
					</UnsavedScope>
				</StatusScopeContext.Provider>
			</PanelScopeContext.Provider>
		</PanelBarContext.Provider>
	);
}
