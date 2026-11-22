import type { Activity, SyncRun } from "#/lib/api.ts";

export type Status = "ok" | "partial" | "failed";

export interface Stat {
	label: string;
	n: number;
	bad?: boolean;
}

/** One destination or one source within a run. */
export interface Part {
	id: string;
	title?: string;
	seconds: number;
	stats: Stat[];
	items: string[];
	errors: string[];
	failedTotal: number;
}

/** Where a run came from, for telling runs apart in a history of several sources. */
export type HistorySource = ActivityKind | "tailscale" | "r2";

/** What kind of run an activity row is: an import folder's, or the rekordbox file's. */
export type ActivityKind = "import" | "rekordbox";

/** A run of any import or export source, in the shape the shared history UI shows. */
export interface HistoryEntry {
	key: string;
	source: HistorySource;
	title: string;
	startedAt: number;
	finishedAt: number;
	status: Status;
	stats: Stat[];
	parts: Part[];
	scope: "sync" | "activity";
	ids: number[];
}

function statusOf(ok: number, failed: number): Status {
	if (failed === 0) {
		return "ok";
	}
	return ok > 0 ? "partial" : "failed";
}

const sum = (parts: readonly Stat[][], label: string) =>
	parts.reduce((n, stats) => n + (stats.find((s) => s.label === label)?.n ?? 0), 0);

function mergeStats(all: Stat[][]): Stat[] {
	const labels = [...new Set(all.flat().map((s) => s.label))];
	return labels.map((label) => {
		const bad = all.flat().find((s) => s.label === label)?.bad;
		return { label, n: sum(all, label), ...(bad ? { bad } : {}) };
	});
}

function syncStats(r: SyncRun): Stat[] {
	return [
		{ label: "uploaded", n: r.uploaded },
		{ label: "up to date", n: r.skipped },
		{ label: "removed", n: r.deleted },
		{ label: "failed", n: r.failed, bad: true },
	];
}

export function targetLabel(r: Pick<SyncRun, "tailnet" | "machine" | "path">): string {
	const where = r.path.join(" / ");
	const name = r.tailnet.startsWith("r2:") ? `R2 · ${r.machine}` : r.machine;
	return where ? `${name} / ${where}` : name;
}

/** Destinations synced by one command share a batch; older rows (batch 0) stand alone. */
export function syncEntries(runs: readonly SyncRun[]): HistoryEntry[] {
	const groups = new Map<string, SyncRun[]>();
	for (const r of runs) {
		const key = r.batch > 0 ? `b${r.batch}` : `r${r.id}`;
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	return [...groups.entries()].map(([key, rs]) => {
		const stats = rs.map(syncStats);
		const failed = rs.reduce((n, r) => n + r.failed, 0);
		const done = rs.some((r) => r.uploaded + r.skipped > 0);
		const first = rs[0];
		return {
			key,
			// A batch of several is marked by its first; they all went out with one command.
			source: first?.tailnet.startsWith("r2:") ? "r2" : "tailscale",
			title: rs.length === 1 && first ? targetLabel(first) : `${rs.length} destinations`,
			startedAt: Math.min(...rs.map((r) => r.startedAt)),
			finishedAt: Math.max(...rs.map((r) => r.finishedAt)),
			status: statusOf(done ? 1 : 0, failed),
			stats: mergeStats(stats),
			parts: rs.map((r) => ({
				id: String(r.id),
				title: targetLabel(r),
				seconds: r.finishedAt - r.startedAt,
				stats: syncStats(r),
				items: [],
				errors: r.errors,
				failedTotal: r.failed,
			})),
			scope: "sync",
			ids: rs.map((r) => r.id),
		};
	});
}

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

const ACTIVITY: Record<
	ActivityKind,
	{ ok: string; skipped: string; title: (a: Activity) => string }
> = {
	import: {
		ok: "tracks added",
		skipped: "skipped",
		title: (a) =>
			a.items.length === 1
				? (a.items[0] ?? "")
				: plural(a.items.length, "album added", "albums added"),
	},
	rekordbox: {
		ok: "tracks exported",
		skipped: "skipped",
		title: (a) => (a.failed > 0 ? "Export failed" : "Library exported"),
	},
};

export function activityEntries(rows: readonly Activity[], source: ActivityKind): HistoryEntry[] {
	const copy = ACTIVITY[source];
	return rows.map((a) => {
		const stats: Stat[] = [
			{ label: copy.ok, n: a.ok },
			{ label: copy.skipped, n: a.skipped },
			{ label: "failed", n: a.failed, bad: true },
		];
		return {
			key: `a${a.id}`,
			source,
			title: copy.title(a),
			startedAt: a.startedAt,
			finishedAt: a.finishedAt,
			status: statusOf(a.ok, a.failed),
			stats,
			parts: [
				{
					id: String(a.id),
					seconds: a.finishedAt - a.startedAt,
					stats,
					items: a.items,
					errors: a.errors,
					failedTotal: a.failed,
				},
			],
			scope: "activity",
			ids: [a.id],
		};
	});
}

/** Several sources' runs in one history, newest first. */
export function mergedHistory(...lists: readonly (readonly HistoryEntry[])[]): HistoryEntry[] {
	return lists.flat().sort((a, b) => b.finishedAt - a.finishedAt);
}
