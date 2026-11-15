import type { ReactNode } from "react";

/** The look of one kind of change in a diff: add, change, move or remove. */
export type Tone = "add" | "change" | "move" | "remove";

export const TONE: Record<Tone, { sign: string; row: string; text: string }> = {
	add: { sign: "+", row: "bg-success/10", text: "text-success" },
	change: { sign: "~", row: "bg-warning/10", text: "text-warning" },
	move: { sign: "→", row: "bg-sky-500/10", text: "text-sky-400" },
	remove: { sign: "−", row: "bg-destructive/10", text: "text-destructive" },
};

/** One diff line: a coloured sign and text on a tinted background. */
export function DiffLine({ tone, children }: { tone: Tone; children: ReactNode }) {
	const st = TONE[tone];
	return (
		<span className={`flex items-start gap-2 px-2 py-0.5 ${st.row}`}>
			<span className={`w-3 shrink-0 text-center font-bold ${st.text}`}>{st.sign}</span>
			<span className="min-w-0 flex-1 break-all">{children}</span>
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
		<span className="inline-flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm tabular-nums">
			{shown.map((i) => (
				<span key={i.label} className={TONE[i.tone].text}>
					{TONE[i.tone].sign}
					{i.count.toLocaleString()} <span className="text-muted-foreground">{i.label}</span>
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

/** A selectable row of a diff: checkbox, diff lines, and a size or other detail on the right. */
export function DiffRow({
	picked,
	onToggle,
	label,
	aside,
	disabled,
	children,
}: {
	picked: boolean;
	onToggle: () => void;
	/** Accessible name of the checkbox. */
	label: string;
	aside?: ReactNode;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<label
			className={`flex cursor-pointer items-stretch gap-2 font-mono text-xs leading-snug hover:bg-muted/40 ${picked ? "" : "opacity-40"}`}
		>
			<input
				type="checkbox"
				aria-label={label}
				className="mt-1.5 size-3.5 shrink-0 accent-primary"
				checked={picked}
				onChange={onToggle}
				disabled={disabled}
			/>
			<span className="min-w-0 flex-1">{children}</span>
			{aside !== undefined && (
				<span className="shrink-0 self-center text-muted-foreground tabular-nums">{aside}</span>
			)}
		</label>
	);
}

/** Muted explanation under a diff line. */
export function DiffNote({ children }: { children: ReactNode }) {
	return <span className="block px-2 pt-0.5 pl-7 text-warning/90 text-xs italic">{children}</span>;
}

/** A folder's changes under an `@@ folder @@` header with a select-all checkbox. */
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
	return (
		<section className="overflow-clip rounded-md border">
			<div className="sticky -top-4 z-10 flex items-center gap-2 border-b bg-muted px-2 py-1 font-mono text-xs">
				<input
					type="checkbox"
					aria-label={`Select all in ${dir}`}
					className="size-3.5 shrink-0 accent-primary"
					checked={picked === total}
					disabled={disabled}
					ref={(el) => {
						if (el) {
							el.indeterminate = picked > 0 && picked < total;
						}
					}}
					onChange={() => onToggleAll(picked !== total)}
				/>
				<span className="min-w-0 flex-1 break-all text-muted-foreground">@@ {dir} @@</span>
				{tallies
					.filter((t) => t.count > 0)
					.map((t) => (
						<span key={t.tone} className={`shrink-0 ${TONE[t.tone].text}`}>
							{TONE[t.tone].sign}
							{t.count}
						</span>
					))}
			</div>
			<div className="space-y-px py-1 pr-2 pl-2">{children}</div>
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
