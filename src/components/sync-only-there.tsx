import { useId, useState } from "react";
import { groupByDir, TONE, type Tone } from "#/components/diff-view.tsx";
import { Button } from "#/components/ui/button.tsx";
import { formatBytes } from "#/lib/format.ts";
import type { ThereChoice, ThereFile } from "#/lib/sync-choices.ts";
import { cn } from "#/lib/utils.ts";

const ROWS_PER_PAGE = 200;
const dirOf = (f: ThereFile) => f.rel.slice(0, -1).join("/") || "(top level)";
const nameOf = (f: ThereFile) => f.rel.at(-1) ?? "";

const CHOICE: Record<ThereChoice, { label: string; tone: Tone | null }> = {
	pull: { label: "Copy here", tone: "add" },
	delete: { label: "Delete there", tone: "remove" },
	leave: { label: "Leave", tone: null },
};

const options = (f: ThereFile): ThereChoice[] => [
	...(f.pull ? (["pull"] as const) : []),
	...(f.remove ? (["delete"] as const) : []),
	"leave",
];

/** A small segmented control: the choices one file allows, the current one filled. */
function ChoicePicker({
	file,
	value,
	onChange,
}: {
	file: ThereFile;
	value: ThereChoice;
	onChange: (v: ThereChoice) => void;
}) {
	const name = useId();
	return (
		<fieldset className="inline-flex shrink-0 overflow-clip rounded-md border text-xs">
			<legend className="sr-only">What to do with {file.key}</legend>
			{options(file).map((c) => {
				const on = value === c;
				const tone = CHOICE[c].tone;
				return (
					<label
						key={c}
						className={cn(
							"cursor-pointer border-l px-2 py-0.5 first-of-type:border-l-0 has-focus-visible:ring-2 has-focus-visible:ring-ring/60",
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

/**
 * Files only on the destination, folder by folder: each is copied into the library, deleted from
 * the destination or left, one choice per file. The buttons on top set every file at once.
 */
export function OnlyThereList({
	files,
	choice,
	onChoose,
	onChooseAll,
}: {
	files: readonly ThereFile[];
	choice: (f: ThereFile) => ThereChoice;
	onChoose: (f: ThereFile, c: ThereChoice) => void;
	/** Sets `c` on every file that allows it; `null` puts each back to its suggestion. */
	onChooseAll: (c: ThereChoice | null) => void;
}) {
	const [shown, setShown] = useState(ROWS_PER_PAGE);
	const hunks = groupByDir(files, dirOf, nameOf);
	let budget = shown;
	return (
		<div>
			<div className="flex flex-wrap items-center gap-2 border-b px-[var(--diff-inset,0)] py-2 text-xs">
				<span className="text-muted-foreground">All:</span>
				{files.some((f) => f.pull) && (
					<Button size="sm" variant="outline" onClick={() => onChooseAll("pull")}>
						Copy here
					</Button>
				)}
				{files.some((f) => f.remove) && (
					<Button size="sm" variant="outline" onClick={() => onChooseAll("delete")}>
						Delete there
					</Button>
				)}
				<Button size="sm" variant="outline" onClick={() => onChooseAll("leave")}>
					Leave
				</Button>
				<Button size="sm" variant="ghost" onClick={() => onChooseAll(null)}>
					Suggested
				</Button>
			</div>
			{hunks.map(([dir, list]) => {
				if (budget <= 0) {
					return null;
				}
				const rows = list.slice(0, budget);
				budget -= rows.length;
				return (
					<section key={dir} className="border-b last:border-b-0">
						<h4 className="border-b bg-card px-[var(--diff-inset,0)] py-2 font-medium text-sm">
							{dir}
						</h4>
						<ul className="divide-y divide-border/60">
							{rows.map((f) => (
								<li
									key={f.key}
									className="flex items-center gap-3 px-[var(--diff-inset,0)] py-1.5 text-sm"
								>
									<span className="min-w-0 flex-1">
										<span className="block break-words">{nameOf(f)}</span>
										{f.note && (
											<span className="mt-0.5 block text-muted-foreground text-xs">{f.note}</span>
										)}
									</span>
									<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
										{formatBytes(f.size)}
									</span>
									<ChoicePicker file={f} value={choice(f)} onChange={(c) => onChoose(f, c)} />
								</li>
							))}
						</ul>
					</section>
				);
			})}
			{files.length > shown && (
				<Button
					variant="ghost"
					size="sm"
					className="mx-[var(--diff-inset,0)] my-2"
					onClick={() => setShown(shown + ROWS_PER_PAGE)}
				>
					Show more ({(files.length - shown).toLocaleString()} hidden)
				</Button>
			)}
		</div>
	);
}
