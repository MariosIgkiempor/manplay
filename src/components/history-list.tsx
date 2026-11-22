import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	ArrowUp,
	Check,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	CircleX,
	Clock,
	type LucideIcon,
	Trash2,
	TriangleAlert,
	X,
} from "lucide-react";
import { useState } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { FailureList } from "#/components/failure-list.tsx";
import { FrameSection } from "#/components/frame.tsx";
import { EmptyState } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { dismissActivity, dismissSyncRuns } from "#/lib/api.ts";
import { duration, timeAgo } from "#/lib/format.ts";
import type { HistoryEntry, HistorySource, Part, Stat, Status } from "#/lib/history.ts";
import { isMac } from "#/lib/platform.ts";
import { cn } from "#/lib/utils.ts";

const COLLAPSED_ROWS = 10;

const STATUS = {
	ok: { Icon: CircleCheck, tone: "text-success", label: "Completed" },
	partial: { Icon: CircleAlert, tone: "text-warning", label: "Completed with errors" },
	failed: { Icon: CircleX, tone: "text-destructive", label: "Failed" },
} as const satisfies Record<Status, unknown>;

/** Plain-language cause for the most common failures. */
function hint(error: string): string | null {
	if (/operation not permitted|permission denied/i.test(error)) {
		return isMac
			? "macOS is blocking access to a folder. Grant manplay (or the app that launches it) access under System Settings → Privacy & Security → Files & Folders / Full Disk Access."
			: "Windows is blocking access to a folder. Check that the folder is not read-only, and that Controlled folder access in Windows Security allows manplay.";
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

/** The colour of a figure by what it counts: things done, things left alone, things lost. */
function toneOf(stat: Stat): string {
	if (stat.bad) {
		return "text-destructive";
	}
	if (/removed|deleted/.test(stat.label)) {
		return "text-destructive";
	}
	if (/up to date|skipped|already/.test(stat.label)) {
		return "text-muted-foreground";
	}
	return "text-success";
}

const isQuiet = (s: Stat) => toneOf(s) === "text-muted-foreground";

/** An icon for what a count counts, so a row reads at a glance; the words are in the tooltip. */
function iconOf(stat: Stat): LucideIcon | null {
	if (stat.bad) {
		return TriangleAlert;
	}
	if (/removed|deleted/.test(stat.label)) {
		return Trash2;
	}
	if (/up to date|skipped|already/.test(stat.label)) {
		return Check;
	}
	return ArrowUp;
}

/**
 * The counts of a run on one line, zero ones left out. In a row only what changed shows, as an
 * icon and a number; the details list everything with the words, quiet counts included.
 */
function Figures({ stats, all = false }: { stats: readonly Stat[]; all?: boolean }) {
	const shown = stats.filter((s) => s.n > 0 && (all ? true : !isQuiet(s)));
	if (shown.length === 0) {
		return <span className="text-muted-foreground text-xs">Nothing changed</span>;
	}
	return (
		<span className="flex items-center gap-x-3 whitespace-nowrap text-xs tabular-nums">
			{shown.map((s) => {
				const Icon = iconOf(s);
				return (
					<span
						key={s.label}
						data-hint={`${s.n.toLocaleString()} ${s.label}`}
						className="inline-flex items-center gap-1"
					>
						{!all && Icon && <Icon aria-hidden="true" className={cn("size-3.5", toneOf(s))} />}
						<span className={cn("font-medium", toneOf(s))}>{s.n.toLocaleString()}</span>
						{all && <span className="text-muted-foreground">{s.label}</span>}
						{!all && <span className="sr-only">{s.label}</span>}
					</span>
				);
			})}
		</span>
	);
}

function PartDetail({ part, titled }: { part: Part; titled: boolean }) {
	const tip = part.errors.map(hint).find((h) => h !== null);
	return (
		<div className="space-y-2 px-[var(--diff-inset)]">
			{titled && part.title && (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="break-words font-medium text-sm">{part.title}</span>
					<span className="flex items-center gap-1 text-muted-foreground text-xs">
						<Clock className="size-3" /> {duration(part.seconds)}
					</span>
				</div>
			)}
			<Figures stats={part.stats} all />
			{part.items.length > 0 && (
				<ul className="max-h-60 space-y-0.5 overflow-auto text-sm">
					{part.items.map((item) => (
						<li key={item} className="truncate" data-hint={item}>
							{item}
						</li>
					))}
				</ul>
			)}
			{tip && <p className="text-warning text-xs">{tip}</p>}
			{part.errors.length > 0 && (
				<FailureList messages={part.errors} total={part.failedTotal} heading={false} />
			)}
		</div>
	);
}

const took = (e: HistoryEntry) => {
	const s = e.finishedAt - e.startedAt;
	return s > 0 ? ` · took ${duration(s)}` : "";
};

/**
 * When a run finished, for its row: how long ago for today's, else the time of day. The day
 * itself is the heading the row sits under.
 */
function finishedLabel(unixSeconds: number): string {
	const finished = new Date(unixSeconds * 1000);
	if (finished.toDateString() === new Date().toDateString()) {
		return timeAgo(unixSeconds);
	}
	return finished.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** The day a run belongs under: Today, Yesterday, or the date. */
function dayLabel(unixSeconds: number): string {
	const day = new Date(unixSeconds * 1000);
	const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((startOf(new Date()) - startOf(day)) / 86_400_000);
	if (days === 0) {
		return "Today";
	}
	if (days === 1) {
		return "Yesterday";
	}
	return day.toLocaleDateString(undefined, {
		weekday: days < 7 ? "long" : undefined,
		day: "numeric",
		month: "long",
		year: day.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	});
}

/** The mark each source's runs carry in a history of several. */
const SOURCE_BRAND: Record<HistorySource, Brand> = {
	import: "folder",
	rekordbox: "rekordbox",
	tailscale: "tailscale",
	r2: "cloudflare",
};

function Row({
	entry,
	titled,
	marked,
	open,
	onToggle,
	onDismiss,
}: {
	entry: HistoryEntry;
	/** Show the run's own title; without it the time is the heading. */
	titled: boolean;
	/** Show which source the run is of, in a history of several. */
	marked: boolean;
	open: boolean;
	onToggle: () => void;
	onDismiss: () => void;
}) {
	const { Icon, tone, label } = STATUS[entry.status];
	return (
		<li className="group/row">
			<div className="flex items-center gap-2 px-3 transition-colors hover:bg-foreground/[0.03]">
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					<ChevronRight
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
							open && "rotate-90",
						)}
					/>
					<Icon role="img" aria-label={label} className={cn("size-[18px] shrink-0", tone)} />
					{marked && (
						<BrandIcon
							brand={SOURCE_BRAND[entry.source]}
							className="size-5 shrink-0 rounded-[5px]"
						/>
					)}
					<span
						className="min-w-0 flex-1"
						data-hint={new Date(entry.finishedAt * 1000).toLocaleString()}
					>
						{titled ? (
							<>
								<span className="block truncate font-medium text-sm leading-5">{entry.title}</span>
								<span className="block truncate text-muted-foreground text-xs leading-5">
									{finishedLabel(entry.finishedAt)}
									{took(entry)}
								</span>
							</>
						) : (
							<span className="block truncate font-medium text-sm leading-5">
								{finishedLabel(entry.finishedAt)}
								<span className="font-normal text-muted-foreground">{took(entry)}</span>
							</span>
						)}
					</span>
					<span className="shrink-0">
						<Figures stats={entry.stats} />
					</span>
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
			{open && (
				<div className="space-y-4 border-hairline border-t bg-black/10 py-3 [--diff-inset:1rem]">
					{entry.parts.map((p) => (
						<PartDetail key={p.id} part={p} titled={entry.parts.length > 1} />
					))}
				</div>
			)}
		</li>
	);
}

/** Past runs under their day, newest first. Pressing one opens its details right under it. */
export function HistoryList({
	entries,
	empty,
	titled = true,
	marked = false,
}: {
	entries: readonly HistoryEntry[];
	empty: string;
	/** Name each run. Turn off where every run is of the page's own destination. */
	titled?: boolean;
	/** Mark each run with its source's icon, where runs of several sources are listed together. */
	marked?: boolean;
}) {
	const queryClient = useQueryClient();
	const [expanded, setExpanded] = useState(false);
	const [openKey, setOpenKey] = useState<string | null>(null);
	const dismiss = useMutation({
		mutationFn: (e: HistoryEntry) =>
			e.scope === "sync" ? dismissSyncRuns(e.ids) : dismissActivity(e.ids),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["activity"] });
		},
	});
	const visible = expanded ? entries : entries.slice(0, COLLAPSED_ROWS);
	const hidden = entries.length - COLLAPSED_ROWS;
	if (entries.length === 0) {
		return <EmptyState title={empty} className="py-8" />;
	}
	const days: [string, HistoryEntry[]][] = [];
	for (const e of visible) {
		const label = dayLabel(e.finishedAt);
		const last = days.at(-1);
		if (last?.[0] === label) {
			last[1].push(e);
		} else {
			days.push([label, [e]]);
		}
	}
	return (
		<>
			<div className="space-y-4">
				{days.map(([label, list]) => (
					<FrameSection key={label} title={label}>
						<ul className="divide-y divide-hairline">
							{list.map((e) => (
								<Row
									key={e.key}
									entry={e}
									titled={titled}
									marked={marked}
									open={openKey === e.key}
									onToggle={() => setOpenKey(openKey === e.key ? null : e.key)}
									onDismiss={() => dismiss.mutate(e)}
								/>
							))}
						</ul>
					</FrameSection>
				))}
			</div>
			{hidden > 0 && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="w-full py-2 text-center text-muted-foreground text-xs hover:text-foreground"
				>
					{expanded ? "Show less" : `Show ${hidden} older`}
				</button>
			)}
		</>
	);
}
