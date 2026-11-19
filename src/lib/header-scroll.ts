/** Where a page header that scrolls away before its lists stands, in pixels scrolled off. */
export interface HeaderScroll {
	/** How far the header is scrolled off, 0 to `height`. */
	offset: number;
	height: number;
	/** The list under the pointer is scrolled to its top. */
	listAtTop: boolean;
}

/**
 * The header's offset after a wheel step, or `null` when the step belongs to the list instead.
 * Down moves the header off first; up brings it back only once the list is at its top. Sideways
 * and pinch (Ctrl) wheels are never the header's.
 */
export function headerOffsetAfter(
	{ offset, height, listAtTop }: HeaderScroll,
	wheel: { deltaX: number; deltaY: number; ctrlKey: boolean },
): number | null {
	const { deltaX, deltaY, ctrlKey } = wheel;
	if (ctrlKey || Math.abs(deltaX) > Math.abs(deltaY)) {
		return null;
	}
	const down = deltaY > 0 && offset < height;
	const up = deltaY < 0 && offset > 0 && listAtTop;
	return down || up ? Math.min(height, Math.max(0, offset + deltaY)) : null;
}
