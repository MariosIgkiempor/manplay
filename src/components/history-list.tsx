import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	ArrowDown,
	ArrowUp,
	Check,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	CircleX,
	Clock,
	History,
	type LucideIcon,
	Trash2,
	TriangleAlert,
	X,
} from "lucide-react";
import { useState } from "react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { CreditLine } from "#/components/credit-line.tsx";
import { FailureList } from "#/components/failure-list.tsx";
import { WellCard } from "#/components/frame.tsx";
import { EmptyState } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
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

/** A common failure in plain words: what went wrong, the fix, and the whole explanation. */
interface Tip {
	problem: string;
	fix: string;
	full: string;
}

/** Plain-language cause for the most common failures. */
function hint(error: string): Tip | null {
	if (/operation not permitted|permission denied/i.test(error)) {
		return isMac
			? {
					problem: "macOS blocks a folder",
					fix: "Allow manplay in Privacy & Security",
					full: "macOS is blocking access to a folder. Grant manplay (or the app that launches it) access under System Settings → Privacy & Security → Files & Folders / Full Disk Access.",
				}
			: {
					problem: "Windows blocks a folder",
					fix: "Check read-only and Controlled folder access",
					full: "Windows is blocking access to a folder. Check that the folder is not read-only, and that Controlled folder access in Windows Security allows manplay.",
				};
	}
	if (/access denied|\b40[13]\b/i.test(error)) {
		return {
			problem: "Credentials rejected",
			fix: "Check the key's permissions and bucket name",
			full: "The destination rejected the credentials. Check the key's permissions and the bucket name.",
		};
	}
	if (/unreachable|timed out|dns|connect/i.test(error)) {
		return {
			problem: "Unreachable",
			fix: "Check your connection and that it is online",
			full: "The destination could not be reached. Check your connection and that it is online.",
		};
	}
	if (/MKCOL 409/i.test(error)) {
		return {
			problem: "Folder refused",
			fix: "Check the shared folder exists and is writable",
			full: "The destination refused to create a folder. Check that the shared folder still exists and is writable.",
		};
	}
	if (/no such file|not found/i.test(error)) {
		return {
			problem: "File gone",
			fix: "Rescan your library",
			full: "The file or folder no longer exists. Rescan your library.",
		};
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
function iconOf(stat: Stat, source?: HistorySource): LucideIcon | null {
	if (stat.bad) {
		return TriangleAlert;
	}
	if (/removed|deleted/.test(stat.label)) {
		return Trash2;
	}
	if (/up to date|skipped|already/.test(stat.label)) {
		return Check;
	}
	// Imports come into the library, as the sidebar's ↓ says; everything else goes out.
	return source === "import" ? ArrowDown : ArrowUp;
}

/**
 * The counts of a run on one line, zero ones left out. In a row only what changed shows, as an
 * icon and a number; the details list everything with the words, quiet counts included.
 */
function Figures({
	stats,
	all = false,
	source,
}: {
	stats: readonly Stat[];
	all?: boolean;
	source?: HistorySource;
}) {
	const shown = stats.filter((s) => s.n > 0 && (all ? true : !isQuiet(s)));
	if (shown.length === 0) {
		return <span className="text-muted-foreground">Nothing changed</span>;
	}
	return (
		<span className="inline-flex items-center gap-x-3 whitespace-nowrap tabular-nums">
			{shown.map((s) => {
				const Icon = iconOf(s, source);
				return (
					<span key={s.label} className="inline-flex items-center gap-1">
						{!all && Icon && <Icon aria-hidden="true" className={cn("size-3.5", toneOf(s))} />}
						<span className={cn("font-medium", toneOf(s))}>{s.n.toLocaleString()}</span>
						<span className={all ? "text-muted-foreground" : undefined}>{s.label}</span>
					</span>
				);
			})}
		</span>
	);
}

/**
 * A run's item, which the backend names "Artist — Album": the album as the name and the artist
 * after it as a credit, as albums read everywhere else. Anything else is shown as it is.
 */
function ItemName({ item }: { item: string }) {
	const [artist, ...rest] = item.split(" — ");
	const album = rest.join(" — ");
	if (artist === undefined || album === "") {
		return <span className="truncate">{item}</span>;
	}
	return (
		<>
			<span className="min-w-0 shrink truncate">{album}</span>
			<CreditLine artist={artist} className="shrink-[2]" />
		</>
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
			<span className="block text-xs">
				<Figures stats={part.stats} all />
			</span>
			{/* What went wrong comes first: it is what a run is usually opened for. */}
			{tip && (
				<Facts label={tip.full} className="text-xs">
					<Fact tone="warn">{tip.problem}</Fact>
					<span className="text-muted-foreground">{tip.fix}</span>
				</Facts>
			)}
			{part.errors.length > 0 && (
				<FailureList messages={part.errors} total={part.failedTotal} heading={false} />
			)}
			{part.items.length > 0 && (
				<ul className="max-h-60 columns-1 gap-x-8 overflow-auto text-sm @2xl/main:columns-2">
					{part.items.map((item) => (
						<li key={item} className="flex min-w-0 items-center gap-2 py-0.5" data-hint={item}>
							<Check aria-hidden="true" className="size-3 shrink-0 text-success" />
							<ItemName item={item} />
						</li>
					))}
				</ul>
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
		weekday: "short",
		day: "numeric",
		month: "short",
		year: day.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	});
}

/** The mark each source's runs carry in a history of several. */
const SOURCE_BRAND: Record<HistorySource, Brand> = {
	import: "folder",
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
					className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					<ChevronRight
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
							open && "rotate-90",
						)}
					/>
					<Icon role="img" aria-label={label} className={cn("size-4 shrink-0", tone)} />
					{marked && (
						<BrandIcon
							brand={SOURCE_BRAND[entry.source]}
							className="size-5 shrink-0 rounded-[5px]"
						/>
					)}
					{/* What the run did leads; where and when follow, quieter. */}
					<span className="flex min-w-0 flex-1 items-baseline gap-3 text-sm leading-5">
						<Figures stats={entry.stats} source={entry.source} />
						{titled && (
							<span className="min-w-0 truncate text-muted-foreground text-xs">{entry.title}</span>
						)}
					</span>
					<span
						className="shrink-0 text-muted-foreground text-xs tabular-nums"
						data-hint={`${new Date(entry.finishedAt * 1000).toLocaleString()}${took(entry)}`}
					>
						{finishedLabel(entry.finishedAt)}
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
				<div className="animate-in space-y-4 border-hairline border-t bg-foreground/[0.03] py-3 pl-7 fade-in-0 slide-in-from-top-1 duration-150 [--diff-inset:1rem] motion-reduce:animate-none">
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
		return (
			<EmptyState icon={<History />} title={empty}>
				Each run is listed here with what it changed.
			</EmptyState>
		);
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
			{/* One list, the day named once above its runs, instead of a card for every day. */}
			<WellCard rows>
				{days.map(([label, list]) => (
					<section key={label} aria-label={label}>
						<h2 className="bg-foreground/[0.018] px-4 py-1.5 font-medium text-muted-foreground text-xs">
							{label}
						</h2>
						<ul className="divide-y divide-hairline border-hairline border-t">
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
					</section>
				))}
			</WellCard>
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
