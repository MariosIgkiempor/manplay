import { ArrowRight, Check, Lock } from "lucide-react";
import { type ReactNode, useId } from "react";
import { TONE, type Tone } from "#/components/diff-view.tsx";
import { ConflictChoice, MergeTable } from "#/components/sync-incoming.tsx";
import { FieldDiffs, TagDiff } from "#/components/tag-diff.tsx";
import type { Resolution, SyncAction } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { TRASH } from "#/lib/platform.ts";
import {
	type IncomingAction,
	isSettled,
	type ThereChoice,
	type ThereFile,
	thereOptions,
} from "#/lib/sync-choices.ts";
import {
	nameOf,
	type ReviewItem,
	type SendAction,
	signOf,
	type ThereLookup,
	tickable,
} from "#/lib/sync-review-model.ts";
import { mergeDiffs } from "#/lib/tag-change.ts";
import { cn } from "#/lib/utils.ts";

/** What the review's views read and change for one destination. */
export interface ReviewControls {
	picked: (a: SyncAction) => boolean;
	choiceOf: (a: IncomingAction) => Resolution | undefined;
	/** Ticks or unticks one change; unticking a conflict forgets its choice. */
	toggle: (a: SyncAction) => void;
	/** Ticks or unticks every change given that can be ticked. */
	toggleAll: (actions: readonly SyncAction[], on: boolean) => void;
	resolve: (a: IncomingAction, next: Resolution) => void;
	there: ThereLookup;
	chooseThere: (files: readonly ThereFile[], c: ThereChoice) => void;
}

/**
 * A checkbox for every change of a group that can be ticked: ticked, unticked or some of each.
 * `children` gets how many are ticked of how many.
 */
export function TickAll({
	items,
	controls,
	label,
	children,
}: {
	items: readonly ReviewItem[];
	controls: ReviewControls;
	label: string;
	children?: (on: number, total: number) => ReactNode;
}) {
	const actions = tickable(items, controls.choiceOf);
	if (actions.length === 0) {
		return null;
	}
	const on = actions.filter(controls.picked).length;
	return (
		<label className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs">
			<input
				type="checkbox"
				aria-label={label}
				className="size-3.5 accent-primary"
				checked={on === actions.length}
				ref={(el) => {
					if (el) {
						el.indeterminate = on > 0 && on < actions.length;
					}
				}}
				onChange={() => controls.toggleAll(actions, on !== actions.length)}
			/>
			{children?.(on, actions.length)}
		</label>
	);
}

const CHOICE: Record<ThereChoice, { label: string; tone: Tone | null }> = {
	pull: { label: "Copy here", tone: "add" },
	delete: { label: "Delete there", tone: "remove" },
	leave: { label: "Leave", tone: null },
};

/** A small segmented control: the choices files allow, the current one filled. */
export function ThereChoicePicker({
	options,
	value,
	label,
	onChange,
}: {
	options: readonly ThereChoice[];
	/** Null when the files it covers are set differently. */
	value: ThereChoice | null;
	label: string;
	onChange: (v: ThereChoice) => void;
}) {
	const name = useId();
	return (
		<fieldset className="inline-flex shrink-0 overflow-clip rounded-md border text-xs">
			<legend className="sr-only">{label}</legend>
			{options.map((c) => {
				const on = value === c;
				const tone = CHOICE[c].tone;
				return (
					<label
						key={c}
						className={cn(
							"cursor-pointer whitespace-nowrap border-l px-2 py-0.5 first-of-type:border-l-0 has-focus-visible:ring-2 has-focus-visible:ring-ring/60",
							on
								? tone
									? cn(TONE[tone].row, TONE[tone].text, "font-medium")
									: "bg-muted font-medium"
								: "text-muted-foreground hover:bg-muted/50",
						)}
					>
						<input
							type="radio"
							className="sr-only"
							name={name}
							checked={on}
							onChange={() => onChange(c)}
						/>
						{CHOICE[c].label}
					</label>
				);
			})}
		</fieldset>
	);
}

const BRING_WHAT: Record<IncomingAction["kind"], string> = {
	update: `Edited on the destination. Replaces your file; the old one goes to the ${TRASH}.`,
	merge: "Tags edited on both sides. The merged file goes to both.",
	conflict: "Edited on both sides.",
};

/** Which copy a replace without readable tags leaves on the destination. */
function Verdict({ picked }: { picked: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs",
				picked ? "bg-primary/15 font-medium text-primary" : "bg-secondary text-muted-foreground",
			)}
		>
			{picked ? <Check className="size-3" /> : <Lock className="size-3" />}
			{picked ? "Yours → remote" : "Remote kept"}
		</span>
	);
}

const folderOf = (rel: readonly string[]) => rel.slice(0, -1).join(" / ") || "(top level)";

/**
 * Where a moved file goes, in words: the folder it leaves, an arrow, the folder it lands in. A
 * rename inside one folder shows the two names instead.
 */
function MoveLine({ from, to }: { from: readonly string[]; to: readonly string[] }) {
	const sameFolder = folderOf(from) === folderOf(to);
	const was = sameFolder ? (from.at(-1) ?? "") : folderOf(from);
	const now = sameFolder ? (to.at(-1) ?? "") : folderOf(to);
	return (
		<span
			className="flex min-w-0 flex-wrap items-center gap-x-1.5"
			data-hint={`${from.join("/")} → ${to.join("/")}`}
		>
			<span className="break-words text-muted-foreground line-through decoration-muted-foreground/50">
				{was}
			</span>
			<ArrowRight aria-hidden="true" className={cn("size-3 shrink-0", TONE.move.text)} />
			<span className="break-words text-foreground">{now}</span>
		</span>
	);
}

/** What a send does, under its name: where it moves from, or the tags it changes there. */
function SendDetail({
	action: a,
	picked,
	moveAs,
}: {
	action: SendAction;
	picked: boolean;
	moveAs: "path" | "folder";
}) {
	if (a.kind === "move" && a.from) {
		return (
			<span className="block text-muted-foreground text-xs">
				{moveAs === "path" ? (
					<MoveLine from={a.from} to={a.rel} />
				) : (
					`from ${a.from.slice(0, -1).join("/") || "(top level)"}`
				)}
				{a.note && <span className="block text-warning">{a.note}</span>}
			</span>
		);
	}
	if (a.kind === "replace") {
		return (
			<span className="mt-1 block space-y-1">
				{a.note && <span className="block text-warning text-xs">{a.note}</span>}
				{a.tags ? <TagDiff changes={a.tags} keep={picked} /> : <Verdict picked={picked} />}
			</span>
		);
	}
	return a.note ? <span className="block text-muted-foreground text-xs">{a.note}</span> : null;
}

/** A merge's settled fields as pills, and the fields both sides edited to choose between. */
function MergeDetail({ action, controls }: { action: IncomingAction; controls: ReviewControls }) {
	const fields = action.merge ?? [];
	const choice = controls.choiceOf(action);
	const open = fields.filter((f) => f.side === null);
	return (
		<>
			<FieldDiffs diffs={mergeDiffs(fields, choice)} />
			{open.length > 0 && (
				<MergeTable
					fields={open}
					choice={choice}
					onChoose={(next) => controls.resolve(action, next)}
				/>
			)}
		</>
	);
}

/** What an edit on the destination does to the library, with its pills or choices. */
function BringDetail({ action, controls }: { action: IncomingAction; controls: ReviewControls }) {
	return (
		<span className="mt-0.5 block space-y-1.5">
			<span
				className={cn(
					"block text-xs",
					action.kind === "update" ? "text-muted-foreground" : "text-warning",
				)}
			>
				{action.kind === "conflict" && action.note
					? `${BRING_WHAT.conflict} ${action.note}.`
					: BRING_WHAT[action.kind]}
			</span>
			{action.kind === "update" && action.tags && <TagDiff changes={action.tags} />}
			{action.kind === "merge" && <MergeDetail action={action} controls={controls} />}
			{action.kind === "conflict" && (
				<ConflictChoice
					action={action}
					choice={controls.choiceOf(action)}
					onChoose={(next) => controls.resolve(action, next)}
				/>
			)}
		</span>
	);
}

function Sign({ item, there }: { item: ReviewItem; there: ThereLookup }) {
	const { sign, tone } = signOf(item, there);
	return (
		<span
			aria-hidden="true"
			className={cn(
				"w-3 shrink-0 text-center font-mono font-semibold",
				tone ? TONE[tone].text : "text-muted-foreground",
			)}
		>
			{sign}
		</span>
	);
}

/** A file only on the destination: outlined, with its choice unless an album-wide one covers it. */
function ThereRow({
	item,
	file,
	controls,
	shared,
}: {
	item: ReviewItem;
	file: ThereFile;
	controls: ReviewControls;
	shared: boolean;
}) {
	const choice = controls.there(file);
	return (
		<div className="min-w-0 text-sm">
			<div className="flex items-center gap-2">
				<span className="w-3.5 shrink-0" />
				<Sign item={item} there={controls.there} />
				<span
					className={cn(
						"min-w-0 flex-1 break-words rounded-sm outline-1 outline-border outline-dashed outline-offset-2",
						choice === "delete" && "text-muted-foreground line-through",
					)}
					data-hint="Only on the destination"
				>
					{nameOf(item)}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{formatBytes(file.size)}
				</span>
				{!shared && (
					<ThereChoicePicker
						options={thereOptions(file)}
						value={choice}
						label={`What to do with ${file.key}`}
						onChange={(c) => controls.chooseThere([file], c)}
					/>
				)}
			</div>
			{file.note && (
				<span className="block pl-[2.75rem] text-muted-foreground text-xs">{file.note}</span>
			)}
		</div>
	);
}

/** Whether a change's tick is locked: a merge until settled, a conflict until a copy is chosen. */
function tickLocked(item: ReviewItem, controls: ReviewControls, picked: boolean): boolean {
	if (item.side !== "bring") {
		return false;
	}
	return item.action.kind === "conflict"
		? !picked
		: !isSettled(item.action, controls.choiceOf(item.action));
}

/**
 * One file of the review: a tick (or, for a file only on the destination, its choice), the sign,
 * the name and what the change does. `shared` hides a destination-only file's own choice when an
 * album-wide one covers it.
 */
export function ItemRow({
	item,
	controls,
	moveAs = "path",
	shared = false,
}: {
	item: ReviewItem;
	controls: ReviewControls;
	moveAs?: "path" | "folder";
	shared?: boolean;
}) {
	if (item.side === "there") {
		return <ThereRow item={item} file={item.file} controls={controls} shared={shared} />;
	}
	const a = item.action;
	const picked = controls.picked(a);
	return (
		<div className="min-w-0 text-sm">
			<label
				className={cn(
					"flex cursor-pointer items-center gap-2 transition-opacity has-disabled:cursor-default",
					!picked && "opacity-45",
				)}
			>
				<input
					type="checkbox"
					aria-label={a.rel.join("/")}
					className="size-3.5 shrink-0 accent-primary"
					checked={picked}
					disabled={tickLocked(item, controls, picked)}
					onChange={() => controls.toggle(a)}
				/>
				<Sign item={item} there={controls.there} />
				<span className="min-w-0 flex-1 break-words">{nameOf(item)}</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{formatBytes(a.size)}
				</span>
			</label>
			<div className={cn("pl-[2.75rem]", !picked && item.side === "send" && "opacity-60")}>
				{item.side === "send" ? (
					<SendDetail action={item.action} picked={picked} moveAs={moveAs} />
				) : (
					<BringDetail action={item.action} controls={controls} />
				)}
			</div>
		</div>
	);
}
