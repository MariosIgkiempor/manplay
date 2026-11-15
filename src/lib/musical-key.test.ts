import { describe, expect, it } from "vitest";
import { camelot, formatBpm, keyName } from "#/lib/musical-key.ts";

describe("camelot", () => {
	it("maps the wheel's anchors", () => {
		expect(camelot("Am")).toBe("8A");
		expect(camelot("C")).toBe("8B");
		expect(camelot("G#m")).toBe("1A");
		expect(camelot("B")).toBe("1B");
		expect(camelot("C#m")).toBe("12A");
		expect(camelot("E")).toBe("12B");
		expect(camelot("F#")).toBe("2B");
		expect(camelot("Ebm")).toBe("2A");
		expect(camelot("Fm")).toBe("4A");
	});

	it("rejects unknown keys", () => {
		expect(camelot("H")).toBeNull();
		expect(camelot("")).toBeNull();
	});
});

describe("keyName", () => {
	it("spells keys out", () => {
		expect(keyName("Am")).toBe("A minor");
		expect(keyName("Bbm")).toBe("B♭ minor");
		expect(keyName("F#")).toBe("F♯ major");
		expect(keyName("x")).toBeNull();
	});
});

describe("formatBpm", () => {
	it("drops the decimal for whole tempos", () => {
		expect(formatBpm(128)).toBe("128");
		expect(formatBpm(126.43)).toBe("126.4");
		expect(formatBpm(127.98)).toBe("128");
	});
});
