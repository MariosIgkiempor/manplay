import type { ScanStatus } from "#/lib/api.ts";

/** Where a destination's background read stands, as its sidebar row shows it. */
export type DestinationStatus =
	| { kind: "scanning" }
	/** Queued, and never read yet. */
	| { kind: "waiting" }
	| { kind: "error"; message: string }
	| { kind: "upToDate" }
	| { kind: "changes"; toPull: number; toPush: number };

/** One destination's status from the background reads; null when nothing is known about it. */
export function destinationStatus(
	status: ScanStatus | undefined,
	targetId: number,
): DestinationStatus | null {
	if (status === undefined) {
		return null;
	}
	if (status.scanning === targetId) {
		return { kind: "scanning" };
	}
	const scan = status.scans.find((s) => s.targetId === targetId);
	if (scan === undefined) {
		return status.queued.includes(targetId) ? { kind: "waiting" } : null;
	}
	if (scan.error !== null) {
		return { kind: "error", message: scan.error };
	}
	if (scan.toPull + scan.toPush === 0) {
		return { kind: "upToDate" };
	}
	return { kind: "changes", toPull: scan.toPull, toPush: scan.toPush };
}
