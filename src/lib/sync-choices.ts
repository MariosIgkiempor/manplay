import type { Resolution, SyncAction, TargetPlan } from "#/lib/api.ts";

/** Actions that take the destination's version into the library; they live in the Pull list. */
export type IncomingKind = "update" | "merge" | "conflict";
export type PushAction = SyncAction & { kind: Exclude<SyncAction["kind"], IncomingKind> };
export type IncomingAction = SyncAction & { kind: IncomingKind };

export const isIncoming = (a: SyncAction): a is IncomingAction =>
	a.kind === "update" || a.kind === "merge" || a.kind === "conflict";
export const isPush = (a: SyncAction): a is PushAction => !isIncoming(a);

/** A destination's plan reduced to what a push does. */
export type PushPlan = Omit<TargetPlan, "actions"> & { actions: PushAction[] };

/** What the user chose for each merge and conflict, by action id. */
export type Choices = ReadonlyMap<number, Resolution>;

/**
 * Whether an incoming change can run: a merge needs every field both sides edited settled, a
 * conflict needs a copy to keep. An update always can.
 */
export function isSettled(a: IncomingAction, choice: Resolution | undefined): boolean {
	if (a.kind === "conflict") {
		return choice?.keep !== undefined;
	}
	if (a.kind === "merge") {
		return (a.merge ?? []).every((f) => f.side !== null || choice?.fields[f.field] !== undefined);
	}
	return true;
}
