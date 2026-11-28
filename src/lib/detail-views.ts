import type { DetailView } from "#/context/detail-context.ts";

/** Tells one shown thing from another; a song's tab or the list it steps through does not count. */
export function detailViewKey(view: DetailView): string {
	switch (view.kind) {
		case "song":
			return `song:${view.trackId}`;
		case "album":
			return `album:${view.key}`;
		case "artist":
			return `artist:${view.name}`;
		default:
			return JSON.stringify(view);
	}
}

/** What a view is, for a screen reader. */
const LABELS: Record<DetailView["kind"], string> = {
	song: "Song",
	album: "Album",
	artist: "Artist",
	value: "Songs with a tag value",
	edit: "Edit metadata",
	missing: "Missing files",
	issues: "Library issues",
	duplicates: "Duplicates",
	usbExport: "Export to drive",
};

export function detailLabel(view: DetailView): string {
	return LABELS[view.kind];
}

/** Views with lists and grids in them get the wider card. */
const WIDE = new Set<DetailView["kind"]>(["album", "artist", "value", "usbExport"]);
const WIDE_CARD_PX = 672;
const CARD_PX = 576;

/** How wide a view's card is, in pixels, where there is the room. */
export function detailCardWidth(view: DetailView): number {
	return WIDE.has(view.kind) ? WIDE_CARD_PX : CARD_PX;
}
