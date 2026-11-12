import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CircleAlert, CircleCheck, CircleX, Clock, X } from "lucide-react";
import { useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { dismissActivity, dismissSyncRuns } from "#/lib/api.ts";
import { duration, timeAgo } from "#/lib/format.ts";
import type { HistoryEntry, Part, Stat, Status } from "#/lib/history.ts";
import { cn } from "#/lib/utils.ts";

const COLLAPSED_ROWS = 10;

const STATUS = {
	ok: { Icon: CircleCheck, tone: "text-emerald-500", bg: "bg-emerald-500/10", label: "Completed" },
	partial: {
		Icon: CircleAlert,
		tone: "text-amber-500",
		bg: "bg-amber-500/10",
		label: "Completed with errors",
	},
	failed: { Icon: CircleX, tone: "text-destructive", bg: "bg-destructive/10", label: "Failed" },
} as const satisfies Record<Status, unknown>;

/** Plain-language cause for the most common failures. */
function hint(error: string): string | null {
	if (/operation not permitted|permission denied/i.test(error)) {
		return "macOS is blocking access to a folder. Grant manplay (or the app that launches it) access under System Settings → Privacy & Security → Files & Folders / Full Disk Access.";
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

/** Result chips; zero counts are hidden except failures. */
function Stats({ stats }: { stats: readonly Stat[] }) {
	const shown = stats.filter((s) => s.n > 0);
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{shown.map((s) =>
				s.bad ? (
					<Badge key={s.label} variant="destructive" className="h-6 px-2.5 tabular-nums">
						<span className="font-semibold">{s.n.toLocaleString()}</span> {s.label}
					</Badge>
				) : (
					<Badge key={s.label} variant="secondary" className="h-6 px-2.5 font-normal tabular-nums">
						<span className="font-medium">{s.n.toLocaleString()}</span> {s.label}
					</Badge>
				),
			)}
			{shown.length === 0 && <span className="text-muted-foreground text-xs">Nothing to do</span>}
		</div>
	);
}

function PartDetail({ part }: { part: Part }) {
	const tip = part.errors.map(hint).find((h) => h !== null);
	const hidden = part.failedTotal - part.errors.length;
	return (
		<div className="space-y-2 rounded-lg border bg-card p-3">
			{part.title && (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="truncate font-medium text-sm">{part.title}</span>
					<span className="flex items-center gap-1 text-muted-foreground text-xs">
						<Clock className="size-3" /> {duration(part.seconds)}
					</span>
				</div>
			)}
			<Stats stats={part.stats} />
			{part.items.length > 0 && (
				<ul className="max-h-60 space-y-0.5 overflow-auto text-sm">
					{part.items.map((item) => (
						<li key={item} className="truncate" title={item}>
							{item}
						</li>
					))}
				</ul>
			)}
			{tip && (
				<p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-600 text-xs dark:text-amber-400">
					{tip}
				</p>
			)}
			{part.errors.length > 0 && (
				<ul className="max-h-48 space-y-1 overflow-auto font-mono text-destructive text-xs">
					{part.errors.map((e) => (
						<li key={e} className="break-all">
							{e}
						</li>
					))}
				</ul>
			)}
			{hidden > 0 && (
				<p className="text-muted-foreground text-xs">
					Showing the first {part.errors.length} of {part.failedTotal.toLocaleString()} failures.
				</p>
			)}
		</div>
	);
}

const took = (e: HistoryEntry) => {
	const s = e.finishedAt - e.startedAt;
	return s > 0 ? ` · took ${duration(s)}` : "";
};

function Row({
	entry,
	onOpen,
	onDismiss,
}: {
	entry: HistoryEntry;
	onOpen: () => void;
	onDismiss: () => void;
}) {
	const { Icon, tone, bg, label } = STATUS[entry.status];
	return (
		<li className="group/row">
			<div className="flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-muted/40">
				<button
					type="button"
					onClick={onOpen}
					className="flex min-w-0 flex-1 items-center gap-4 text-left"
				>
					<span className={cn("grid size-9 shrink-0 place-items-center rounded-full", bg)}>
						<Icon role="img" aria-label={label} className={cn("size-[18px]", tone)} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate font-medium text-sm leading-5">{entry.title}</span>
						<span
							className="block truncate text-muted-foreground text-xs leading-5"
							title={new Date(entry.finishedAt * 1000).toLocaleString()}
						>
							{timeAgo(entry.finishedAt)}
							{took(entry)}
						</span>
					</span>
					<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
				</button>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="Dismiss"
					className="text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
					onClick={onDismiss}
				>
					<X />
				</Button>
			</div>
		</li>
	);
}

function RunDrawer({ entry, onClose }: { entry: HistoryEntry | null; onClose: () => void }) {
	return (
		<Drawer open={entry !== null} onClose={onClose} title={entry?.title ?? ""} width="w-[28rem]">
			{entry && (
				<div className="space-y-3">
					<p className="text-muted-foreground text-xs">
						{new Date(entry.finishedAt * 1000).toLocaleString()}
						{took(entry)}
					</p>
					{entry.parts.length > 1 && <Stats stats={entry.stats} />}
					{entry.parts.map((p) => (
						<PartDetail key={p.id} part={p} />
					))}
				</div>
			)}
		</Drawer>
	);
}

/** Plain list of past runs (no card); clicking one opens its details in a nested drawer. */
export function HistoryList({
	entries,
	empty,
}: {
	entries: readonly HistoryEntry[];
	empty: string;
}) {
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = useState(false);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const dismiss = useMutation({
		mutationFn: (e: HistoryEntry) =>
			e.scope === "sync" ? dismissSyncRuns(e.ids) : dismissActivity(e.ids),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["activity"] });
		},
	});
	const selected = entries.find((e) => e.key === selectedKey) ?? null;
	const visible = expanded ? entries : entries.slice(0, COLLAPSED_ROWS);
	const hidden = entries.length - COLLAPSED_ROWS;
	return (
		<>
			{entries.length === 0 ? (
				<p className="py-6 text-center text-muted-foreground text-sm">{empty}</p>
			) : (
				<ul className="-mx-2 divide-y">
					{visible.map((e) => (
						<Row
							key={e.key}
							entry={e}
							onOpen={() => setSelectedKey(e.key)}
							onDismiss={() => dismiss.mutate(e)}
						/>
					))}
				</ul>
			)}
			{hidden > 0 && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="w-full py-2 text-center text-muted-foreground text-xs hover:text-foreground"
				>
					{expanded ? "Show less" : `Show ${hidden} older`}
				</button>
			)}
			<RunDrawer entry={selected} onClose={() => setSelectedKey(null)} />
		</>
	);
}
