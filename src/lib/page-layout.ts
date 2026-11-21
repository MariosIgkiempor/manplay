/**
 * Spacing every page shares, so a page's search row and content line up with its header (which
 * uses the same 1.5rem sides): the row under the header that sticks while the page scrolls, and
 * the content below it.
 */
export const PAGE_TOOLBAR =
	"sticky top-0 z-10 space-y-2 border-b bg-background/90 px-6 py-2 backdrop-blur-md";
export const PAGE_BODY = "px-6 pt-6 pb-10";
/**
 * The square that starts a page header (a cover, the page's icon or a brand): one size and one
 * corner for all of them. It shrinks in a short window, where it would otherwise take a third of
 * the height before the page's own content starts.
 */
export const PAGE_ART = "size-28 shrink-0 rounded-lg [@media(max-height:44rem)]:size-16";
