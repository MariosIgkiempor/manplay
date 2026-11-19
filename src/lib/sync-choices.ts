import type { RemoteFile, Resolution, SyncAction, TargetPlan } from "#/lib/api.ts";

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

/** What happens to a file that is only on the destination. */
export type ThereChoice = "pull" | "delete" | "leave";

/** A file only on the destination: one decision, whether it can be copied here, removed there, or both. */
export interface ThereFile {
	/** Its path on the destination, joined with `/`. */
	key: string;
	rel: string[];
	size: number;
	/** Set when it can be copied into the library (an audio file the library lacks). */
	pull: RemoteFile | null;
	/** Set when it can be removed from the destination. */
	remove: PushAction | null;
	note: string | null;
	/** What it starts as. */
	suggested: ThereChoice;
}

/** Which directions a sync starts with: both, or only one. */
export type SyncDirection = "both" | "pull" | "push";

/**
 * Joins the files the library lacks with the deletes the push planned for the same paths, so
 * each destination-only file is one decision. It starts as the planned delete when the push
 * suggests it (a song removed from the library since the last sync), else as a copy here when
 * it is new audio, else left alone. A one-way sync never suggests the other direction.
 */
export function onlyThere(
	missing: readonly RemoteFile[],
	actions: readonly PushAction[],
	direction: SyncDirection,
): ThereFile[] {
	const deletes = new Map(
		actions.filter((a) => a.kind === "delete").map((a) => [a.rel.join("/"), a] as const),
	);
	const out = new Map<string, ThereFile>();
	for (const f of missing) {
		const key = f.rel.join("/");
		const remove = deletes.get(key) ?? null;
		out.set(key, {
			key,
			rel: f.rel,
			size: f.size,
			pull: f,
			remove,
			note: remove?.note ?? (f.otherFormat ? `In library as .${f.otherFormat}` : null),
			suggested: "leave",
		});
	}
	for (const [key, remove] of deletes) {
		if (!out.has(key)) {
			out.set(key, {
				key,
				rel: remove.rel,
				size: remove.size,
				pull: null,
				remove,
				note: remove.note,
				suggested: "leave",
			});
		}
	}
	return [...out.values()].map((f) => ({ ...f, suggested: suggest(f, direction) }));
}

function suggest(f: ThereFile, direction: SyncDirection): ThereChoice {
	if (f.remove && !f.remove.optional && direction !== "pull") {
		return "delete";
	}
	if (f.pull && !f.pull.otherFormat && !f.remove?.note && direction !== "push") {
		return "pull";
	}
	return "leave";
}

/**
 * Sets `choice` on every file of destination `targetId` that allows it, in a map of choices keyed
 * `targetId:path`. `null` drops each back to its suggestion.
 */
export function chooseAll(
	current: ReadonlyMap<string, ThereChoice>,
	targetId: number,
	files: readonly ThereFile[],
	choice: ThereChoice | null,
): Map<string, ThereChoice> {
	const next = new Map(current);
	for (const f of files) {
		const at = `${targetId}:${f.key}`;
		if (choice === null) {
			next.delete(at);
		} else if (choice === "leave" || (choice === "pull" ? f.pull : f.remove)) {
			next.set(at, choice);
		}
	}
	return next;
}

/**
 * Whether an action runs: its suggestion, unless `flipped` by the user. Opt-in changes start
 * unticked, as does the direction a one-way sync leaves out. A merge or conflict only runs once
 * its `choice` settles it; a conflict is ticked by choosing a copy.
 */
export function isPicked(
	a: SyncAction,
	direction: SyncDirection,
	flipped: boolean,
	choice: Resolution | undefined,
): boolean {
	if (isIncoming(a)) {
		return isSettled(a, choice) && (a.kind === "conflict" || (direction !== "push") !== flipped);
	}
	return (!a.optional && direction !== "pull") !== flipped;
}
