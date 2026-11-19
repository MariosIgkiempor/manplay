import { Check } from "lucide-react";
import type { FieldMerge, Resolution, Side } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { TRASH } from "#/lib/platform.ts";
import type { IncomingAction } from "#/lib/sync-choices.ts";
import { labelOf } from "#/lib/tag-preview.ts";
import { cn } from "#/lib/utils.ts";

const nameOf = (a: IncomingAction) => a.rel.at(-1) ?? "";

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
export function MergeTable({
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
export function ConflictChoice({
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
