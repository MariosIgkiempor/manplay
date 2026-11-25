/**
 * Spacing every page shares, so a page's search row and content line up with its header (which
 * uses the same 1.5rem sides): the row under the header that sticks while the page scrolls, and
 * the content below it.
 */
export const PAGE_TOOLBAR =
	"sticky top-0 z-30 space-y-2 border-hairline border-b bg-background px-6 py-2";
export const PAGE_BODY = "px-6 pt-6 pb-10";
/**
 * The small square that starts a page header's line (a cover or a brand): one size and one
 * corner for all of them, the size of the sidebar's marks.
 */
export const PAGE_ART = "size-7 shrink-0 rounded-md";

/**
 * The inset surface groups of rows sit in (the "well" of the bezel): a step lighter than the
 * page, a hairline edge, and a faint shadow under it so it reads as set into the frame.
 */
export const WELL =
	"rounded-xl border border-hairline bg-well shadow-[0_1px_2px_0_oklch(0_0_0/30%)]";
/** The frame round a well: a thin lip, a shade lighter than the page, that names the group. */
export const FRAME = "rounded-2xl border border-hairline bg-foreground/[0.018] p-1";

/** A well whose direct children are rows split by hairlines. */
export const WELL_ROWS = `${WELL} divide-y divide-hairline overflow-hidden`;

/** The dimmed window behind a dialog, fading in as it opens. */
export const DIALOG_BACKDROP =
	"absolute inset-0 animate-in bg-canvas/70 backdrop-blur-sm fade-in-0 duration-150 motion-reduce:animate-none";
/** A dialog's own frame: a touch brighter edge than a page's, rising slightly as it opens. */
export const DIALOG_FRAME =
	"relative animate-in rounded-2xl border border-foreground/10 bg-background shadow-2xl fade-in-0 zoom-in-[0.97] duration-150 motion-reduce:animate-none";

/**
 * A card set into the window's canvas: the page, and any pane opened beside it. A hairline a
 * touch brighter than the ones inside, with a faint highlight along its top edge.
 */
export const CARD =
	"rounded-xl border border-foreground/9 bg-background shadow-[0_1px_0_0_oklch(1_0_0/4%)_inset]";

/**
 * The bottom deck's columns: the sidebar's width on the left (the song, the grid editor's
 * controls), the rest for the transport and waveforms, lined up with the page above.
 */
export const DECK_COLUMNS = "grid grid-cols-[max(var(--sidebar-width,15rem),13rem)_minmax(0,1fr)]";

/** The id of the place in the status bar where the sidebar puts its fold button. */
export const SIDEBAR_TOGGLE_SLOT = "sidebar-toggle-slot";

/**
 * The frame of a card that floats over the page (`GrowPopup`, the shortcut sheet): the same lip
 * round a well as a section of a page (`FRAME`), on a solid ground since it lies over other
 * things, lifted by a deep shadow. Its content sits in a `WELL` inside it.
 */
export const FLOATING_FRAME =
	"rounded-2xl border border-hairline bg-[color-mix(in_oklab,var(--foreground)_2%,var(--background))] p-1 text-foreground shadow-2xl outline-none";
