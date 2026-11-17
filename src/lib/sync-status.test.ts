import { describe, expect, it } from "vitest";
import type { PlanId, ScanStatus, ScanSummary } from "#/lib/api.ts";
import { type DestinationStatus, destinationStatus } from "#/lib/sync-status.ts";

const summary = (over: Partial<ScanSummary>): ScanSummary => ({
	targetId: 1,
	planId: "1-1" as PlanId,
	scannedAt: 0,
	error: null,
	toPull: 0,
	toPush: 0,
	...over,
});

const status = (over: Partial<ScanStatus>): ScanStatus => ({
	scans: [],
	queued: [],
	scanning: null,
	...over,
});

describe("destinationStatus", () => {
	it.each<{ name: string; status: ScanStatus | undefined; expected: DestinationStatus | null }>([
		{ name: "not loaded", status: undefined, expected: null },
		{ name: "unknown", status: status({}), expected: null },
		{
			name: "waiting for its first read",
			status: status({ queued: [1] }),
			expected: { kind: "waiting" },
		},
		{
			name: "being read, even with an older read",
			status: status({ scanning: 1, scans: [summary({ toPush: 3 })] }),
			expected: { kind: "scanning" },
		},
		{
			name: "queued again keeps showing the last read",
			status: status({ queued: [1], scans: [summary({})] }),
			expected: { kind: "upToDate" },
		},
		{
			name: "failed",
			status: status({ scans: [summary({ error: "unreachable" })] }),
			expected: { kind: "error", message: "unreachable" },
		},
		{
			name: "with changes",
			status: status({ scans: [summary({ toPull: 2, toPush: 5 })] }),
			expected: { kind: "changes", toPull: 2, toPush: 5 },
		},
		{
			name: "another destination's read",
			status: status({ scanning: 2, scans: [summary({ targetId: 2 })] }),
			expected: null,
		},
	])("$name", ({ status: s, expected }) => {
		expect(destinationStatus(s, 1)).toEqual(expected);
	});
});
