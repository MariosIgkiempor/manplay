import { describe, expect, it } from "vitest";
import {
	nextPreset,
	stepZoom,
	wheelZoom,
	ZOOM_MAX,
	ZOOM_MIN,
	zoomLabel,
} from "#/lib/waveform-zoom.ts";

describe("waveform zoom", () => {
	it("steps in and out within bounds", () => {
		expect(stepZoom(stepZoom(4, 1), -1)).toBeCloseTo(4);
		expect(stepZoom(ZOOM_MIN, 1)).toBe(ZOOM_MIN);
		expect(stepZoom(ZOOM_MAX, -1)).toBe(ZOOM_MAX);
	});

	it("cycles presets from wherever it is", () => {
		expect(nextPreset(2)).toBe(4);
		expect(nextPreset(3)).toBe(4);
		expect(nextPreset(8)).toBe(2);
		expect(nextPreset(20)).toBe(2);
	});

	it("pinches proportionally", () => {
		expect(wheelZoom(4, 0)).toBe(4);
		expect(wheelZoom(4, 10)).toBeGreaterThan(4);
		expect(wheelZoom(4, -10)).toBeLessThan(4);
		expect(wheelZoom(4, -100_000)).toBe(ZOOM_MIN);
	});

	it("labels the whole window", () => {
		expect(zoomLabel(4)).toBe("8s");
		expect(zoomLabel(0.75)).toBe("1.5s");
		expect(zoomLabel(11.3)).toBe("23s");
	});
});
