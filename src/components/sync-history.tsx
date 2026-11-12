import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CircleAlert, CircleCheck, CircleX, Clock, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { dismissSyncRuns, type SyncRun } from "#/lib/api.ts";
import { duration, timeAgo } from "#/lib/format.ts";
import { cn } from "#/lib/utils.ts";

const COLLAPSED_ROWS = 10;

interface Group {
	key: string;
	runs: SyncRun[];
	startedAt: number;
	finishedAt: number;
}

/** Destinations synced by one command share a batch; older rows (batch 0) stand alone. */
function groupRuns(runs: readonly SyncRun[]): Group[] {
	const groups = new Map<string, Group>();
	for (const r of runs) {
		const key = r.batch > 0 ? `b${r.batch}` : `r${r.id}`;
		const g = groups.get(key);
		if (g) {
			g.runs.push(r);
			g.startedAt = Math.min(g.startedAt, r.startedAt);
			g.finishedAt = Math.max(g.finishedAt, r.finishedAt);
		} else {
			groups.set(key, { key, runs: [r], startedAt: r.startedAt, finishedAt: r.finishedAt });
		}
	}
	return [...groups.values()];
}

type Status = "ok" | "partial" | "failed";

function statusOf(runs: readonly SyncRun[]): Status {
	const failed = runs.reduce((n, r) => n + r.failed, 0);
	if (failed === 0) {
		return "ok";
	}
	return runs.some((r) => r.uploaded + r.skipped > 0) ? "partial" : "failed";
}

const STATUS = {
	ok: { Icon: CircleCheck, tone: "text-emerald-500", bg: "bg-emerald-500/10", label: "Completed" },
	partial: {
		Icon: CircleAlert,
		tone: "text-amber-500",
		bg: "bg-amber-500/10",
		label: "Completed with errors",
	},
	failed: { Icon: CircleX, tone: "text-destructive", bg: "bg-destructive/10", label: "Failed" },
} as const;

/** Plain-language cause for the most common failures. */
function hint(error: string): string | null {
	if (/operation not permitted|permission denied/i.test(error)) {
		return "macOS is blocking access to your library folder. Grant manplay (or the app that launches it) access under System Settings → Privacy & Security → Files & Folders / Full Disk Access.";
	}
	if (/access denied|\b40[13]\b/i.test(error)) {
		return "The destination rejected the credentials. Check the key's permissions and the bucket name.";
	}
	if (/unreachable|timed out|dns|connect/i.test(error)) {
		return "The destination could not be reached. Check your connection and that it is online.";
	}
	if (/MKCOL 409/i.test(error)) {
		return "The destination refused to create a folder. Check that the shared folder still exists and is writable.";
	}
	if (/no such file|not found/i.test(error)) {
		return "The file or folder no longer exists. Rescan your library.";
	}
	return null;
}

function targetLabel(r: SyncRun): string {
	const where = r.path.join(" / ");
	const name = r.tailnet.startsWith("r2:") ? `R2 · ${r.machine}` : r.machine;
	return where ? `${name} / ${where}` : name;
}

const STAT_LABELS = [
	["uploaded", "uploaded"],
	["skipped", "up to date"],
	["deleted", "removed"],
] as const;

/** Result chips for one or more runs. */
function Stats({ runs }: { runs: readonly SyncRun[] }) {
	const sum = (k: "uploaded" | "skipped" | "deleted" | "failed") =>
		runs.reduce((n, r) => n + r[k], 0);
	const failed = sum("failed");
	const chips = STAT_LABELS.map(([k, label]) => [sum(k), label] as const).filter(([n]) => n > 0);
	return (
		<div className="flex flex-wrap items-center justify-end gap-1.5">
			{chips.map(([n, label]) => (
				<Badge key={label} variant="secondary" className="h-6 px-2.5 font-normal tabular-nums">
					<span className="font-medium">{n.toLocaleString()}</span> {label}
				</Badge>
			))}
			{failed > 0 && (
				<Badge variant="destructive" className="h-6 px-2.5 tabular-nums">
					<span className="font-semibold">{failed.toLocaleString()}</span> failed
				</Badge>
			)}
			{chips.length === 0 && failed === 0 && (
				<span className="text-muted-foreground text-xs">Nothing to do</span>
			)}
		</div>
	);
}

function RunDetail({ run }: { run: SyncRun }) {
	const shown = run.errors.length;
	const tip = run.errors.map(hint).find((h) => h !== null);
	return (
		<div className="space-y-2 rounded-lg border bg-card p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="truncate font-medium text-sm">{targetLabel(run)}</span>
				<span className="flex items-center gap-1 text-muted-foreground text-xs">
					<Clock className="size-3" /> {duration(run.finishedAt - run.startedAt)}
				</span>
			</div>
			<Stats runs={[run]} />
			{shown > 0 && (
				<div className="space-y-2">
					{tip && (
						<p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-600 text-xs dark:text-amber-400">
							{tip}
						</p>
					)}
					<ul className="max-h-48 space-y-1 overflow-auto font-mono text-destructive text-xs">
						{run.errors.map((e) => (
							<li key={e} className="break-all">
								{e}
							</li>
						))}
					</ul>
					{run.failed > shown && (
						<p className="text-muted-foreground text-xs">
							Showing the first {shown} of {run.failed.toLocaleString()} failures.
						</p>
					)}
				</div>
			)}
		</div>
	);
}

function GroupRow({ group, onDismiss }: { group: Group; onDismiss: (ids: number[]) => void }) {
	const [open, setOpen] = useState(false);
	const status = statusOf(group.runs);
	const { Icon, tone, bg, label } = STATUS[status];
	const first = group.runs[0];
	const title =
		group.runs.length === 1 && first ? targetLabel(first) : `${group.runs.length} destinations`;
	const when = new Date(group.finishedAt * 1000).toLocaleString();
	return (
		<li className="group/row">
			<div className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-muted/40">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-4 text-left"
				>
					<span className={cn("grid size-9 shrink-0 place-items-center rounded-full", bg)}>
						<Icon role="img" aria-label={label} className={cn("size-[18px]", tone)} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate font-medium text-sm leading-5">{title}</span>
						<span className="block truncate text-muted-foreground text-xs leading-5" title={when}>
							{timeAgo(group.finishedAt)} · took {duration(group.finishedAt - group.startedAt)}
						</span>
					</span>
					<span className="hidden shrink-0 md:block">
						<Stats runs={group.runs} />
					</span>
				</button>
				<div className="flex shrink-0 items-center gap-0.5">
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={open ? "Collapse" : "Expand"}
						onClick={() => setOpen(!open)}
					>
						<ChevronDown className={cn("transition-transform", open && "rotate-180")} />
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Dismiss"
						className="text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
						onClick={() => onDismiss(group.runs.map((r) => r.id))}
					>
						<X />
					</Button>
				</div>
			</div>
			{open && (
				<div className="space-y-2 border-t bg-muted/20 px-4 py-3 md:pl-[4.25rem]">
					<div className="md:hidden">
						<Stats runs={group.runs} />
					</div>
					{group.runs.map((r) => (
						<RunDetail key={r.id} run={r} />
					))}
				</div>
			)}
		</li>
	);
}

export function SyncHistory({ runs }: { runs: readonly SyncRun[] }) {
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = useState(false);
	const groups = useMemo(() => groupRuns(runs), [runs]);
	const dismiss = useMutation({
		mutationFn: dismissSyncRuns,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sync-history"] }),
	});

	if (groups.length === 0) {
		return (
			<div className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
				No syncs yet.
			</div>
		);
	}
	const visible = expanded ? groups : groups.slice(0, COLLAPSED_ROWS);
	const hidden = groups.length - COLLAPSED_ROWS;
	return (
		<div className="overflow-hidden rounded-xl border bg-card">
			<ul className="divide-y">
				{visible.map((g) => (
					<GroupRow key={g.key} group={g} onDismiss={(ids) => dismiss.mutate(ids)} />
				))}
			</ul>
			{hidden > 0 && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="w-full border-t px-4 py-2 text-center text-muted-foreground text-xs hover:bg-muted/50"
				>
					{expanded ? "Show less" : `Show ${hidden} older`}
				</button>
			)}
		</div>
	);
}
