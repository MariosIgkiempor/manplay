/** Classes every right-click menu shares. */
export const menuItem =
	"flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";
/**
 * A row that opens a submenu. It keeps its highlight while its submenu is open only as long as it
 * has focus, so the highlight moves into the submenu along with focus.
 */
export const submenuTrigger = `${menuItem} data-[open]:not-focus:bg-transparent`;
export const popup =
	"z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground text-sm shadow-lg outline-none";

/** Classes the Picker and the Select share: an input-looking trigger over a small list popup. */
export const pickerTrigger =
	"flex h-8 items-center gap-1.5 rounded-lg border border-input bg-transparent pr-2 pl-2.5 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[open]:bg-muted/50 dark:bg-input/30";
export const pickerPopup =
	"min-w-(--anchor-width) rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none";
export const pickerItem =
	"flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-sm outline-none data-[highlighted]:bg-muted";
