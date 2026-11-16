import type { ReactNode } from "react";

/** The look of one kind of change in a diff: add, change, move or remove. */
export type Tone = "add" | "change" | "move" | "remove";

export const TONE: Record<Tone, { sign: string; row: string; text: string }> = {
	add: { sign: "+", row: "bg-success/10", text: "text-success" },
	change: { sign: "~", row: "bg-warning/10", text: "text-warning" },
	move: { sign: "→", row: "bg-move/10", text: "text-move" },
	remove: { sign: "−", row: "bg-destructive/10", text: "text-destructive" },
};

/**
 * Every diff row and folder header shares these columns, so checkboxes, signs, names and sizes
 * line up down the whole list: checkbox | sign | name | size.
 */
const GRID = "grid grid-cols-[1rem_0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 px-3";

function Sign({ tone }: { tone: Tone }) {
	return (
		<span aria-hidden="true" className={`text-center font-semibold ${TONE[tone].text}`}>
			{TONE[tone].sign}
		</span>
	);
}

export interface TallyItem {
	tone: Tone;
	label: string;
	count: number;
}

/** Signed, colour-coded counts such as `+12 push  −3 delete`. Zero counts are left out. */
export function Tally({
	items,
	empty = "No changes",
}: {
	items: readonly TallyItem[];
	empty?: string;
}) {
	const shown = items.filter((i) => i.count > 0);
	if (shown.length === 0) {
		return <span className="text-muted-foreground text-sm">{empty}</span>;
	}
	return (
		<span className="inline-flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
			{shown.map((i) => (
				<span key={i.label}>
					<span className={`font-medium ${TONE[i.tone].text}`}>
						{TONE[i.tone].sign}
						{i.count.toLocaleString()}
					</span>{" "}
					<span className="text-muted-foreground">{i.label}</span>
				</span>
			))}
		</span>
	);
}

export function ProgressBar({ done, total }: { done: number; total: number }) {
	return (
		<div
			role="progressbar"
			aria-valuenow={done}
			aria-valuemax={total}
			className="h-1 overflow-hidden rounded-full bg-muted"
		>
			<div
				className="h-full bg-primary transition-all"
				style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }}
			/>
		</div>
	);
}

/**
 * A selectable row of a diff: checkbox, coloured sign, the file name, and a size on the right.
 * `detail` is one muted line under the name, such as where a renamed file came from.
 */
export function DiffRow({
	tone,
	name,
	detail,
	warn,
	extra,
	picked,
	onToggle,
	label,
	aside,
	disabled,
}: {
	tone: Tone;
	name: ReactNode;
	detail?: ReactNode;
	/** Shows `detail` in the warning colour: something the user should look at before ticking. */
	warn?: boolean;
	/** Anything else under the name, such as the tags a replace changes. */
	extra?: ReactNode;
	picked: boolean;
	onToggle: () => void;
	/** Accessible name of the checkbox. */
	label: string;
	aside?: ReactNode;
	disabled?: boolean;
}) {
	return (
		<label
			className={`${GRID} cursor-pointer py-1.5 text-sm transition-opacity hover:bg-muted/40 has-disabled:cursor-default ${picked ? "" : "opacity-45"}`}
		>
			<input
				type="checkbox"
				aria-label={label}
				className="size-3.5 translate-y-0.5 self-start accent-primary"
				checked={picked}
				onChange={onToggle}
				disabled={disabled}
			/>
			<Sign tone={tone} />
			<span className="min-w-0">
				<span className="block break-words">{name}</span>
				{detail && (
					<span
						className={`mt-0.5 block break-words text-xs ${warn ? "text-warning" : "text-muted-foreground"}`}
					>
						{detail}
					</span>
				)}
				{extra && <span className="mt-1 block">{extra}</span>}
			</span>
			<span className="text-right text-muted-foreground text-xs tabular-nums">{aside}</span>
		</label>
	);
}

/** A folder path as a breadcrumb: parent folders muted, the folder itself in full strength. */
function FolderPath({ dir }: { dir: string }) {
	const parts = dir.split("/");
	const last = parts.pop();
	return (
		<span className="min-w-0 break-words">
			{parts.map((p, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: path segments can repeat
				<span key={i} className="text-muted-foreground">
					{p}
					<span className="px-1 opacity-50">/</span>
				</span>
			))}
			<span className="font-medium">{last}</span>
		</span>
	);
}

/** A folder's changes under a header with the folder path, its counts and a select-all checkbox. */
export function DiffHunk({
	dir,
	total,
	picked,
	onToggleAll,
	tallies,
	disabled,
	children,
}: {
	dir: string;
	total: number;
	picked: number;
	onToggleAll: (on: boolean) => void;
	tallies: readonly { tone: Tone; count: number }[];
	disabled?: boolean;
	children: ReactNode;
}) {
	const shown = tallies.filter((t) => t.count > 0);
	return (
		<section className="overflow-clip rounded-lg border">
			<label
				className={`${GRID} sticky -top-4 z-10 cursor-pointer border-b bg-card py-2 text-sm has-disabled:cursor-default`}
			>
				<input
					type="checkbox"
					aria-label={`Select all in ${dir}`}
					className="size-3.5 translate-y-0.5 self-start accent-primary"
					checked={picked === total}
					disabled={disabled}
					ref={(el) => {
						if (el) {
							el.indeterminate = picked > 0 && picked < total;
						}
					}}
					onChange={() => onToggleAll(picked !== total)}
				/>
				<span className="col-span-2 min-w-0">
					<FolderPath dir={dir} />
				</span>
				<span className="flex gap-2.5 text-xs tabular-nums">
					{shown.map((t) => (
						<span key={t.tone} className={TONE[t.tone].text}>
							{TONE[t.tone].sign}
							{t.count}
						</span>
					))}
				</span>
			</label>
			<div className="divide-y divide-border/60">{children}</div>
		</section>
	);
}

/** Groups items by folder, sorted by folder and then by name, like the hunks of a diff. */
export function groupByDir<T>(
	items: readonly T[],
	dirOf: (item: T) => string,
	nameOf: (item: T) => string,
): [string, T[]][] {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const dir = dirOf(item);
		groups.set(dir, [...(groups.get(dir) ?? []), item]);
	}
	const cmp = (x: string, y: string) => x.localeCompare(y, undefined, { sensitivity: "base" });
	return [...groups]
		.sort(([x], [y]) => cmp(x, y))
		.map(([dir, list]) => [dir, list.toSorted((x, y) => cmp(nameOf(x), nameOf(y)))]);
}
