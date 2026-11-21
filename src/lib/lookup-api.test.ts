import { describe, expect, it } from "vitest";
import { recordingIdSchema, releaseIdSchema } from "#/lib/api.ts";

const UUID = "170d8783-40b3-4b0b-879d-0ef6055dfeb3";

describe("releaseIdSchema", () => {
	it.each([
		[UUID, true],
		["discogs-27651", true],
		["discogs-0", true],
		["", false],
		["27651", false],
		["discogs-", false],
		["discogs-27651-6", false],
		["discogs-../x", false],
		["discogs-27651?x=1", false],
		["Discogs-27651", false],
		[`${UUID}/extra`, false],
		[27651, false],
		[null, false],
	])("%o is a release id: %o", (raw, accepted) => {
		expect(releaseIdSchema.safeParse(raw).success).toBe(accepted);
	});
});

describe("recordingIdSchema", () => {
	it.each([
		[UUID, true],
		["discogs-27651-6", true],
		["discogs-27651-0", true],
		["", false],
		["discogs-27651", false],
		["discogs-27651-", false],
		["discogs--6", false],
		["discogs-27651-6-1", false],
		["discogs-27651-x", false],
		[null, false],
	])("%o is a recording id: %o", (raw, accepted) => {
		expect(recordingIdSchema.safeParse(raw).success).toBe(accepted);
	});
});
