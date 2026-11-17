import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { DiffHunk, DiffRow, groupByDir } from "#/components/diff-view.tsx";
import { TagDiffInline } from "#/components/tag-diff.tsx";
import type { FieldMerge, Resolution, Side } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { TRASH } from "#/lib/platform.ts";
import {
	type Choices,
	type IncomingAction,
	type IncomingKind,
	isSettled,
} from "#/lib/sync-choices.ts";
import { labelOf } from "#/lib/tag-preview.ts";
import { cn } from "#/lib/utils.ts";

const path = (rel: readonly string[]) => rel.join("/");
const dirOf = (a: IncomingAction) => path(a.rel.slice(0, -1)) || "(top level)";
const nameOf = (a: IncomingAction) => a.rel.at(-1) ?? "";

/** Clicks in a row's detail must not tick the row's checkbox. */
function Inert({ children }: { children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: only stops the click reaching the label
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard never reaches the label through here
		<span className="mt-1 block cursor-default" onClick={(e) => e.preventDefault()}>
			{children}
		</span>
	);
}

const Empty = () => <span className="italic">empty</span>;

/** One value of the merge table; when it is a choice it is a button, and the picked one is tinted. */
function Pick({
	value,
	chosen,
	choosable,
	label,
	onPick,
}: {
	value: string | null;
	/** This value stays. */
	chosen: boolean;
	/** Both sides edited the field, so the user picks. */
	choosable: boolean;
	label: string;
	onPick: () => void;
}) {
	const body = (
		<>
			{chosen && choosable && <Check className="mr-1 inline size-3" />}
			{value ?? <Empty />}
		</>
	);
	const look = cn(
		"min-w-0 break-words px-2 py-0.5 text-left",
		chosen ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground",
		!chosen && value !== null && "line-through decoration-muted-foreground/50",
	);
	if (!choosable) {
		return <span className={look}>{body}</span>;
	}
	return (
		<button
			type="button"
			aria-pressed={chosen}
			aria-label={label}
			onClick={onPick}
			className={cn(
				look,
				"cursor-pointer rounded-sm outline-none ring-1 ring-border ring-inset hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
				chosen && "ring-primary/40",
			)}
		>
			{body}
		</button>
	);
}

/** Base, yours and theirs for each tag both sides touched, with a choice where both edited the same one. */
function MergeTable({
	fields,
	choice,
	onChoose,
}: {
	fields: readonly FieldMerge[];
	choice: Resolution | undefined;
	onChoose: (next: Resolution) => void;
}) {
	const pick = (field: string, side: Side) =>
		onChoose({ ...choice, fields: { ...choice?.fields, [field]: side } });
	return (
		<div className="grid grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-y-0.5 text-sm">
			<span />
			<span className="px-2 text-muted-foreground text-xs">Last synced</span>
			<span className="px-2 text-muted-foreground text-xs">Yours</span>
			<span className="px-2 text-muted-foreground text-xs">Theirs</span>
			{fields.map((f) => {
				const side = f.side ?? choice?.fields[f.field] ?? null;
				const choosable = f.side === null;
				return (
					<div key={f.field} className="col-span-4 grid grid-cols-subgrid items-baseline">
						<span className="truncate text-muted-foreground text-xs">{labelOf(f.field)}</span>
						<span className="min-w-0 break-words px-2 py-0.5 text-muted-foreground">
							{f.base ?? <Empty />}
						</span>
						<Pick
							value={f.mine}
							chosen={side === "mine"}
							choosable={choosable}
							label={`Keep yours for ${labelOf(f.field)}`}
							onPick={() => pick(f.field, "mine")}
						/>
						<Pick
							value={f.theirs}
							chosen={side === "theirs"}
							choosable={choosable}
							label={`Take theirs for ${labelOf(f.field)}`}
							onPick={() => pick(f.field, "theirs")}
						/>
					</div>
				);
			})}
		</div>
	);
}

/** Keep mine (push) or keep theirs (update) for a file whose audio or artwork changed on both sides. */
function ConflictChoice({
	action,
	choice,
	onChoose,
}: {
	action: IncomingAction;
	choice: Resolution | undefined;
	onChoose: (next: Resolution) => void;
}) {
	const options: { side: Side; title: string; size: number | null; result: string }[] = [
		{
			side: "mine",
			title: "Keep mine",
			size: action.localSize,
			result: "Yours replaces the destination copy, which is backed up first.",
		},
		{
			side: "theirs",
			title: "Keep theirs",
			size: action.size,
			result: `Theirs replaces your file, which goes to the ${TRASH}.`,
		},
	];
	return (
		<fieldset className="min-w-0 space-y-1">
			<legend className="sr-only">Which copy of {nameOf(action)} stays</legend>
			<div className="grid grid-cols-2 gap-2">
				{options.map((o) => (
					<button
						key={o.side}
						type="button"
						aria-pressed={choice?.keep === o.side}
						onClick={() => onChoose({ ...choice, fields: choice?.fields ?? {}, keep: o.side })}
						className={cn(
							"flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none ring-1 ring-border ring-inset hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
							choice?.keep === o.side && "bg-primary/10 font-medium text-primary ring-primary/40",
						)}
					>
						<span className="inline-flex items-center gap-1">
							{choice?.keep === o.side && <Check className="size-3" />}
							{o.title}
						</span>
						{o.size !== null && (
							<span className="text-muted-foreground text-xs tabular-nums">
								{formatBytes(o.size)}
							</span>
						)}
					</button>
				))}
			</div>
			<p className="text-muted-foreground text-xs">
				{options.find((o) => o.side === choice?.keep)?.result ?? "Choose which copy stays."}
			</p>
		</fieldset>
	);
}

/** The size on the right: what comes in, and by how much it differs from your file. */
function SizeCell({ action }: { action: IncomingAction }) {
	const delta =
		action.kind === "update" && action.localSize !== null ? action.size - action.localSize : 0;
	return (
		<span className="inline-flex items-baseline gap-2">
			{delta !== 0 && (
				<span className="text-xs opacity-70">
					{delta > 0 ? "+" : "−"}
					{formatBytes(Math.abs(delta))}
				</span>
			)}
			<span className="text-foreground/80">{formatBytes(action.size)}</span>
		</span>
	);
}

const WHAT: Record<IncomingKind, string> = {
	update: `Edited on the destination. Replaces your file; the old one goes to the ${TRASH}.`,
	merge: "Tags edited on both sides. The merged file goes to both.",
	conflict: "Edited on both sides.",
};

function IncomingRow({
	action,
	picked,
	choice,
	onToggle,
	onChoose,
}: {
	action: IncomingAction;
	picked: boolean;
	choice: Resolution | undefined;
	onToggle: () => void;
	onChoose: (next: Resolution) => void;
}) {
	const settled = isSettled(action, choice);
	return (
		<DiffRow
			tone="change"
			name={nameOf(action)}
			detail={
				action.kind === "conflict" && action.note
					? `${WHAT.conflict} ${action.note}.`
					: WHAT[action.kind]
			}
			warn={action.kind !== "update"}
			picked={picked}
			// A conflict is ticked by choosing a copy; unticking forgets the choice.
			disabled={action.kind === "conflict" ? !picked : !settled}
			onToggle={onToggle}
			label={path(action.rel)}
			aside={<SizeCell action={action} />}
			extra={
				<>
					{action.kind === "update" && action.tags && action.tags.length > 0 && (
						<TagDiffInline changes={action.tags} />
					)}
					{action.kind === "merge" && (
						<Inert>
							<MergeTable fields={action.merge ?? []} choice={choice} onChoose={onChoose} />
						</Inert>
					)}
					{action.kind === "conflict" && (
						<Inert>
							<ConflictChoice action={action} choice={choice} onChoose={onChoose} />
						</Inert>
					)}
				</>
			}
		/>
	);
}

/**
 * Files edited on a destination since the last sync, folder by folder: updates that replace the
 * library file, merges of tags both sides edited, and conflicts that need a copy chosen.
 */
export function IncomingList({
	actions,
	picked,
	choices,
	onToggle,
	onToggleAll,
	onChoose,
}: {
	actions: readonly IncomingAction[];
	picked: (a: IncomingAction) => boolean;
	choices: Choices;
	onToggle: (a: IncomingAction) => void;
	onToggleAll: (items: IncomingAction[], on: boolean) => void;
	onChoose: (id: number, next: Resolution) => void;
}) {
	const hunks = groupByDir(actions, dirOf, nameOf);
	return (
		<div>
			{hunks.map(([dir, items]) => (
				<DiffHunk
					key={dir}
					flush
					dir={dir}
					total={items.length}
					picked={items.filter(picked).length}
					onToggleAll={(on) => onToggleAll(items, on)}
					tallies={[{ tone: "change", count: items.length }]}
				>
					{items.map((a) => (
						<IncomingRow
							key={a.id}
							action={a}
							picked={picked(a)}
							choice={choices.get(a.id)}
							onToggle={() => onToggle(a)}
							onChoose={(next) => onChoose(a.id, next)}
						/>
					))}
				</DiffHunk>
			))}
		</div>
	);
}
