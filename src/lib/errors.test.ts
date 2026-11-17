import { describe, expect, it } from "vitest";
import { describeError } from "#/lib/errors.ts";

const KEYCHAIN_DECLINED = "keychain: Platform secure storage failure: User canceled the operation.";

describe("describeError", () => {
	it.each([
		{
			name: "declined keychain prompt",
			raw: KEYCHAIN_DECLINED,
			title: "Keychain access was declined",
		},
		{
			name: "unreachable destination names the cause",
			raw: `destination unreachable: ${KEYCHAIN_DECLINED}`,
			title: "Destination unreachable",
		},
		{
			name: "malformed saved login",
			raw: "keychain: malformed R2 credentials",
			title: "The saved login is unreadable",
		},
		{
			name: "other keychain failure",
			raw: "keychain: item not found",
			title: "Could not read the keychain",
		},
		{ name: "unknown message is kept", raw: "disk is full", title: "disk is full" },
		{ name: "Error prefix is dropped", raw: "Error: disk is full", title: "disk is full" },
	])("$name", ({ raw, title }) => {
		expect(describeError(raw).title).toBe(title);
	});

	it("explains an unreachable destination by its cause", () => {
		expect(describeError(`destination unreachable: ${KEYCHAIN_DECLINED}`).detail).toContain(
			"choose Allow",
		);
	});

	it("falls back to the raw cause when the cause has no rule", () => {
		expect(describeError("destination unreachable: timed out").detail).toBe("timed out");
	});
});
