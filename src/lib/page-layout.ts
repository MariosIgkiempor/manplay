/**
 * Spacing every page shares, so a page's search row and content line up with its header (which
 * uses the same 1.5rem sides): the row under the header that sticks while the page scrolls, and
 * the content below it.
 */
export const PAGE_TOOLBAR =
	"sticky top-0 z-10 space-y-2 border-hairline border-b bg-background px-6 py-2";
export const PAGE_BODY = "px-6 pt-6 pb-10";
/**
 * The square that starts a page header (a cover, the page's icon or a brand): one size and one
 * corner for all of them. It shrinks in a short window, where it would otherwise take a third of
 * the height before the page's own content starts.
 */
export const PAGE_ART = "size-16 shrink-0 rounded-lg [@media(max-height:44rem)]:size-12";

/**
 * The inset surface groups of rows sit in (the "well" of the bezel): a step lighter than the
 * page, a hairline edge, and a faint shadow under it so it reads as set into the frame.
 */
export const WELL =
	"rounded-xl border border-hairline bg-well shadow-[0_1px_2px_0_oklch(0_0_0/30%)]";
/** The frame round a well: a thin lip, a shade lighter than the page, that names the group. */
export const FRAME = "rounded-2xl border border-hairline bg-white/[0.018] p-1";

/** A well whose direct children are rows split by hairlines. */
export const WELL_ROWS = `${WELL} divide-y divide-hairline overflow-hidden`;

/** The dimmed window behind a dialog, fading in as it opens. */
export const DIALOG_BACKDROP =
	"absolute inset-0 animate-in bg-canvas/70 backdrop-blur-sm fade-in-0 duration-150 motion-reduce:animate-none";
/** A dialog's own frame: a touch brighter edge than a page's, rising slightly as it opens. */
export const DIALOG_FRAME =
	"relative animate-in rounded-2xl border border-white/10 bg-background shadow-2xl fade-in-0 zoom-in-[0.97] duration-150 motion-reduce:animate-none";

/**
 * A card set into the window's canvas: the page, and any pane opened beside it. A hairline a
 * touch brighter than the ones inside, with a faint highlight along its top edge.
 */
export const CARD =
	"rounded-xl border border-white/9 bg-background shadow-[0_1px_0_0_oklch(1_0_0/4%)_inset]";
