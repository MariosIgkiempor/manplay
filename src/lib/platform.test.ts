import { describe, expect, it } from "vitest";
import { keyLabel } from "./platform.ts";

describe("keyLabel", () => {
	it("keeps Mac symbols on a Mac", () => {
		expect(keyLabel("⌘⌫", true)).toBe("⌘⌫");
	});

	it("spells keys out on Windows", () => {
		expect(keyLabel("⌘K", false)).toBe("Ctrl+K");
		expect(keyLabel("⌘⌫", false)).toBe("Del");
		expect(keyLabel("⇧← ⇧→", false)).toBe("Shift+← Shift+→");
		expect(keyLabel("⌘↵", false)).toBe("Ctrl+Enter");
		expect(keyLabel("⇧, ⇧.", false)).toBe("Shift+, Shift+.");
		expect(keyLabel("Move the grid 10 ms (⌥ 1 ms)", false)).toBe("Move the grid 10 ms (Alt 1 ms)");
	});
});
