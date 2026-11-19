import { describe, expect, it } from "vitest";
import { type HeaderScroll, headerOffsetAfter } from "#/lib/header-scroll.ts";

const at = (offset: number, listAtTop = true): HeaderScroll => ({ offset, height: 100, listAtTop });
const wheel = (deltaY: number, deltaX = 0, ctrlKey = false) => ({ deltaX, deltaY, ctrlKey });

describe("headerOffsetAfter", () => {
	it.each<{
		name: string;
		state: HeaderScroll;
		step: ReturnType<typeof wheel>;
		expected: number | null;
	}>([
		{ name: "down moves the header off first", state: at(0), step: wheel(30), expected: 30 },
		{ name: "down stops once the header is gone", state: at(90), step: wheel(30), expected: 100 },
		{
			name: "down scrolls the list once the header is gone",
			state: at(100),
			step: wheel(30),
			expected: null,
		},
		{
			name: "up brings the header back at the list's top",
			state: at(100),
			step: wheel(-40),
			expected: 60,
		},
		{
			name: "up scrolls the list first while it is not at its top",
			state: at(100, false),
			step: wheel(-40),
			expected: null,
		},
		{
			name: "up does nothing more once the header is back",
			state: at(0),
			step: wheel(-40),
			expected: null,
		},
		{
			name: "sideways wheels belong to the list",
			state: at(0),
			step: wheel(5, 30),
			expected: null,
		},
		{ name: "pinch zoom is left alone", state: at(0), step: wheel(30, 0, true), expected: null },
	])("$name", ({ state, step, expected }) => {
		expect(headerOffsetAfter(state, step)).toBe(expected);
	});
});
