import type { PlanId, ScanStatus } from "#/lib/api.ts";

/** What a review needs to know of one destination's read. */
export interface ReadRef {
	targetId: number;
	planId: PlanId;
}

/** The latest read of each destination, or `null` if it has none or the user waited past it. */
export function latestReads<R extends ReadRef>(
	reads: readonly (R | null | undefined)[],
	stale: ReadonlySet<PlanId>,
): (R | null)[] {
	return reads.map((read) => (read != null && !stale.has(read.planId) ? read : null));
}

/**
 * The read shown for each destination: while `frozen` (the user ticked something, or a run is
 * going) the pinned one stays; otherwise the latest, falling back to the pinned one. The same read
 * shown again (e.g. after ignoring some of its files) replaces the pinned copy even while frozen:
 * its plan and choices stay valid.
 */
export function shownReads<R extends ReadRef>(
	ids: readonly number[],
	latest: readonly (R | null)[],
	pinned: ReadonlyMap<number, R>,
	frozen: boolean,
): (R | null)[] {
	return ids.map((id, i) => {
		const pin = pinned.get(id);
		const next = latest[i] ?? null;
		if (frozen && pin) {
			return next?.planId === pin.planId ? next : pin;
		}
		return next ?? pin ?? null;
	});
}

/** Whether a destination has a read newer than the one pinned on screen. */
export function hasNewerRead(
	ids: readonly number[],
	latest: readonly (ReadRef | null)[],
	pinned: ReadonlyMap<number, ReadRef>,
): boolean {
	return ids.some((id, i) => {
		const next = latest[i];
		const current = pinned.get(id);
		return next != null && current !== undefined && current.planId !== next.planId;
	});
}

/**
 * Destinations that were never read and are not queued or being read: the review asks for them.
 * `reads` is `undefined` while loading and `null` when the backend has no read.
 */
export function unreadTargets(
	ids: readonly number[],
	reads: readonly (ReadRef | null | undefined)[],
	status: ScanStatus | undefined,
): number[] {
	if (status === undefined) return [];
	return ids.filter(
		(id, i) => reads[i] === null && status.scanning !== id && !status.queued.includes(id),
	);
}

/** Another destination is being read first. */
export function waitingOnOther(ids: readonly number[], status: ScanStatus | undefined): boolean {
	return status?.scanning != null && !ids.includes(status.scanning);
}
