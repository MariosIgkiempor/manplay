import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Ban,
	Calendar1,
	CalendarArrowDown,
	CalendarArrowUp,
	CalendarClock,
	CalendarDays,
	CalendarRange,
	History,
	Infinity as InfinityIcon,
	type LucideIcon,
	Metronome,
	Plus,
	Sparkles,
	Tag as TagIcon,
	X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { LinkButton } from "#/components/check-list.tsx";
import { LocalTagsDialog } from "#/components/item-sharing.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { Picker, type PickerOption } from "#/components/picker.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	type AddedRule,
	type LocalTagUse,
	listTags,
	type SmartPlaylist,
	type SmartPreview,
	type SmartRules,
	saveSmartPlaylist,
	shareItem,
	smartLocalTags,
} from "#/lib/api.ts";
import { plural } from "#/lib/export-selection.ts";
import { duration, formatBytes } from "#/lib/format.ts";
import { useRefreshItems } from "#/lib/queries.ts";
import {
	type AddedKind,
	addedKind,
	autoName,
	DEVICE_ONLY_FILTERS,
	dateInput,
	describeParts,
	describeRules,
	type FilterKind,
	fromDateInput,
	isUnknownTag,
	type Part,
	placeTag,
	ROLE_FIELD,
	removeTag,
	roleOf,
	ruleTagLabel,
	sameRules,
	type TagRole,
	withAddedKind,
} from "#/lib/smart-rules.ts";
import { TAG_SEP, tagLeaf } from "#/lib/tag-tree.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { useAutosave } from "#/lib/unsaved.tsx";
import {
	SMART_KEY,
	useCreateSmartPlaylist,
	useSmartPlaylists,
	useSmartPreview,
} from "#/lib/use-smart.ts";
import { cn } from "#/lib/utils.ts";

function useDebounced<T>(value: T, ms: number): T {
	const [shown, setShown] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setShown(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return shown;
}

// ---- picking smart playlists for an export ----------------------------------

function PickRow({
	playlist,
	on,
	onToggle,
	onOpen,
}: {
	playlist: SmartPlaylist;
	on: boolean;
	onToggle: (on: boolean) => void;
	onOpen: () => void;
}) {
	const preview = useSmartPreview(playlist.rules);
	const count = preview.data?.trackIds.length;
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-lg px-2 transition-colors hover:bg-muted/60",
				on && "bg-primary/5",
			)}
		>
			<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-sm">
				<input
					type="checkbox"
					checked={on}
					onChange={(e) => onToggle(e.target.checked)}
					className="size-4 shrink-0 accent-primary"
				/>
				<Sparkles className="size-4 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span className="block truncate">{playlist.name}</span>
					<span className="block truncate text-muted-foreground text-xs">
						{describeRules(playlist.rules)}
					</span>
				</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{count === undefined ? "…" : plural(count, "track")}
				</span>
			</label>
			<Button
				size="icon-sm"
				variant="ghost"
				onClick={onOpen}
				aria-label={`Open ${playlist.name}`}
				title="Open to edit its rules"
			>
				<ArrowUpRight />
			</Button>
		</div>
	);
}

/**
 * The Smart tab of an export: the library's smart playlists, ticked to go to this destination.
 * Their songs are worked out from the rules at export time. Editing happens on their own page.
 */
export function SmartPicker({
	chosen,
	onChosen,
	onLeave,
}: {
	chosen: readonly number[];
	onChosen: (next: number[]) => void;
	/** Closes the drawer before going to a smart playlist's page. */
	onLeave: () => void;
}) {
	const navigate = useNavigate();
	const list = useSmartPlaylists();
	const create = useCreateSmartPlaylist();
	const all = list.data ?? [];
	const on = new Set(chosen);
	const count = all.filter((p) => on.has(p.id)).length;
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-3 text-xs">
				<p className="text-muted-foreground">Songs are picked by the rules when you export</p>
				{all.length > 0 && (
					<div className="flex shrink-0 gap-3">
						<LinkButton
							disabled={count === all.length}
							onClick={() => onChosen(all.map((p) => p.id))}
						>
							Select all
						</LinkButton>
						<LinkButton disabled={count === 0} onClick={() => onChosen([])}>
							Clear
						</LinkButton>
					</div>
				)}
			</div>
			{list.isError && <ErrorLine>{String(list.error)}</ErrorLine>}
			{all.length > 0 && (
				<div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border bg-background p-1">
					{all.map((p) => (
						<PickRow
							key={p.id}
							playlist={p}
							on={on.has(p.id)}
							onToggle={(include) =>
								onChosen(
									include
										? [...chosen.filter((id) => id !== p.id), p.id]
										: chosen.filter((id) => id !== p.id),
								)
							}
							onOpen={() => {
								onLeave();
								void navigate({ to: "/smart/$id", params: { id: String(p.id) } });
							}}
						/>
					))}
				</div>
			)}
			{list.isSuccess && all.length === 0 && (
				<p className="py-4 text-center text-muted-foreground text-sm">
					No smart playlists yet. Make one from rules like “instrumental and house”, and it shows up
					here.
				</p>
			)}
			<Button
				variant="outline"
				size="sm"
				onClick={() => {
					onLeave();
					create.mutate();
				}}
				disabled={create.isPending}
			>
				<Plus /> New smart playlist
			</Button>
			{create.isError && <ErrorLine>{String(create.error)}</ErrorLine>}
		</div>
	);
}

// ---- the builder --------------------------------------------------------------

const MAX_MATCHES = 8;
const ARROWS: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

/** A tag path with its parents quiet: Genre › **House**. */
function TagPath({ name }: { name: string }) {
	if (isUnknownTag(name)) {
		return (
			<span
				className="min-w-0 truncate text-muted-foreground italic"
				title="Not a tag on this device"
			>
				Unknown tag
			</span>
		);
	}
	const parts = name.split(TAG_SEP);
	const leaf = parts.pop();
	return (
		<span className="min-w-0 truncate">
			{parts.map((p) => (
				<span key={p} className="text-muted-foreground">
					{p} ›{" "}
				</span>
			))}
			{leaf}
		</span>
	);
}

/**
 * How each tag group reads. The badge names the logic (AND, OR, NOT) and the same word sits between
 * the group's tags, so it is plain whether one tag or all of them are needed.
 */
const ROLES: Record<
	TagRole,
	{ op: string; join: string; title: string; chip: string; bar: string; badge: string }
> = {
	all: {
		op: "AND",
		join: "and",
		title: "Must have every one of these",
		chip: "bg-primary/15",
		bar: "border-primary",
		badge: "bg-primary text-primary-foreground",
	},
	any: {
		op: "OR",
		join: "or",
		title: "Must have at least one of these",
		chip: "bg-primary/15",
		bar: "border-primary",
		badge: "bg-primary text-primary-foreground",
	},
	none: {
		op: "NOT",
		join: "or",
		title: "Must have none of these",
		chip: "bg-destructive/15 text-destructive",
		bar: "border-destructive",
		badge: "bg-destructive text-white",
	},
};

/** A chosen tag in a group's input. */
function RoleChip({ tag, role, onRemove }: { tag: string; role: TagRole; onRemove: () => void }) {
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-0.5 rounded-md py-0.5 pr-0.5 pl-2 text-sm",
				ROLES[role].chip,
			)}
		>
			<TagPath name={tag} />
			<button
				type="button"
				onClick={onRemove}
				aria-label={`Remove ${tag}`}
				className="rounded p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
			>
				<X className="size-3" />
			</button>
		</span>
	);
}

/**
 * The tags of one group, picked from the library's own tags (a typo would silently match nothing,
 * so there is no free text). A tag already in another group moves here when picked.
 */
function RuleTags({
	rules,
	group,
	onPick,
	onRemove,
	placeholder,
	autoFocus = false,
}: {
	rules: SmartRules;
	group: TagRole;
	onPick: (tag: string) => void;
	onRemove: (tag: string) => void;
	placeholder: string;
	autoFocus?: boolean;
}) {
	const listId = useId();
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const value = rules[ROLE_FIELD[group]];
	const needle = text.trim().toLowerCase();
	const matches = (tags.data ?? [])
		.filter((t) => t.trackCount > 0 && roleOf(rules, t.name) !== group)
		.filter((t) => needle === "" || t.name.toLowerCase().includes(needle))
		.slice(0, MAX_MATCHES);
	const add = (name: string) => {
		onPick(name);
		setText("");
		setActive(0);
	};
	const step = (by: number) => {
		setOpen(true);
		setActive((i) => (matches.length === 0 ? 0 : (i + by + matches.length) % matches.length));
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		const arrow = ARROWS[e.key];
		if (arrow !== undefined) {
			e.preventDefault();
			step(arrow);
		} else if (e.key === "Enter" && open && matches[active]) {
			e.preventDefault();
			add(matches[active].name);
		} else if (e.key === "Backspace" && text === "" && value.length > 0) {
			onRemove(value[value.length - 1] ?? "");
		} else if (e.key === "Escape" && open) {
			e.stopPropagation();
			setOpen(false);
		}
	};
	return (
		<div className="relative">
			<div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
				{value.map((name, i) => (
					<span key={name} className="contents">
						{i > 0 && (
							<span className="px-0.5 text-muted-foreground text-xs">{ROLES[group].join}</span>
						)}
						<RoleChip tag={name} role={group} onRemove={() => onRemove(name)} />
					</span>
				))}
				<input
					role="combobox"
					aria-expanded={open}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-label={ROLES[group].title}
					// biome-ignore lint/a11y/noAutofocus: opened by the user to add tags here
					autoFocus={autoFocus}
					value={text}
					placeholder={value.length === 0 ? placeholder : "Add a tag"}
					onChange={(e) => {
						setText(e.target.value);
						setActive(0);
						setOpen(true);
					}}
					onFocus={() => setOpen(true)}
					onBlur={() => setOpen(false)}
					onKeyDown={onKeyDown}
					className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
				/>
			</div>
			{open && (
				<div
					id={listId}
					role="listbox"
					className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border bg-popover p-1 shadow-md"
				>
					{matches.map((t, i) => {
						const from = roleOf(rules, t.name);
						return (
							<div
								key={t.id}
								role="option"
								tabIndex={-1}
								aria-selected={i === active}
								// Keep focus in the input so the list stays open for the next pick.
								onMouseDown={(e) => {
									e.preventDefault();
									add(t.name);
								}}
								onMouseEnter={() => setActive(i)}
								className={cn(
									"flex cursor-pointer items-center gap-3 rounded-md px-2 py-1 text-sm",
									i === active && "bg-muted",
								)}
							>
								<TagPath name={t.name} />
								{from && (
									<span className="shrink-0 text-muted-foreground text-xs">
										moves from {ROLES[from].op}
									</span>
								)}
								<span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
									{t.trackCount.toLocaleString()}
								</span>
							</div>
						);
					})}
					{matches.length === 0 && (
						<p className="px-2 py-1 text-muted-foreground text-sm">
							{needle === "" ? "Every tag is already here." : `No tag contains “${text.trim()}”.`}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

/** One tag group: its logic badge and rule on a coloured bar, then its tags. */
function TagGroup({
	group,
	rules,
	setRules,
	placeholder,
}: {
	group: TagRole;
	rules: SmartRules;
	setRules: (next: SmartRules) => void;
	placeholder: string;
}) {
	const { op, title, bar, badge } = ROLES[group];
	return (
		<div className={cn("space-y-1.5 border-l-2 pl-3", bar)}>
			<p className="flex items-center gap-2 text-sm">
				<span
					className={cn(
						"w-9 shrink-0 rounded py-px text-center font-semibold text-[0.6875rem] tracking-wide",
						badge,
					)}
				>
					{op}
				</span>
				{title}
			</p>
			<RuleTags
				rules={rules}
				group={group}
				placeholder={placeholder}
				onPick={(tag) => setRules(placeTag(rules, tag, group))}
				onRemove={(tag) => setRules(removeTag(rules, tag))}
			/>
		</div>
	);
}

/** "and" between groups: every group with tags has to hold. */
function AndRule() {
	return (
		<p className="flex items-center gap-2 pl-3.5 text-muted-foreground text-xs" aria-hidden="true">
			and
		</p>
	);
}

/** A filter: its icon and name in its colour, as the sentence above shows it, then its controls. */
function FilterRow({
	kind,
	onClear,
	children,
}: {
	kind: FilterKind;
	/** Shown while the filter is set; turns it back to "any". */
	onClear?: (() => void) | undefined;
	children: ReactNode;
}) {
	const { icon: Icon, text, label } = FILTER_LOOK[kind];
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
			<span className={cn("flex w-20 shrink-0 items-center gap-1.5 font-medium text-sm", text)}>
				<Icon className="size-3.5" aria-hidden="true" />
				{label}
			</span>
			<div className="flex flex-wrap items-center gap-2">
				{children}
				{DEVICE_ONLY_FILTERS[kind] && (
					<span
						className="rounded border px-1.5 py-px text-muted-foreground text-xs"
						title={DEVICE_ONLY_NOTE}
					>
						This device only
					</span>
				)}
				{onClear && (
					<Button
						size="xs"
						variant="ghost"
						onClick={onClear}
						className="text-muted-foreground"
						aria-label={`Clear the ${label.toLowerCase()} filter`}
					>
						<X /> Clear
					</Button>
				)}
			</div>
		</div>
	);
}

const ADDED_OPTIONS: PickerOption<AddedKind>[] = [
	{ value: "any", label: "Any time", icon: InfinityIcon },
	{ value: "within", label: "In the last", icon: History },
	{ value: "after", label: "On or after", icon: CalendarArrowUp },
	{ value: "before", label: "Before", icon: CalendarArrowDown },
];

const UNIT_OPTIONS: PickerOption<"days" | "weeks" | "months">[] = [
	{ value: "days", label: "days", icon: Calendar1 },
	{ value: "weeks", label: "weeks", icon: CalendarRange },
	{ value: "months", label: "months", icon: CalendarDays },
];

/** A number box that lets the field be empty while typing; `onCommit` gets null when empty. */
function NumberBox({
	value,
	onCommit,
	label,
	placeholder,
	min = 0,
}: {
	value: number | null;
	onCommit: (n: number | null) => void;
	label: string;
	placeholder?: string;
	min?: number;
}) {
	const [text, setText] = useState(value === null ? "" : String(value));
	useEffect(() => {
		setText((t) => (Number(t) === value || (t === "" && value === null) ? t : String(value ?? "")));
	}, [value]);
	return (
		<Input
			type="number"
			inputMode="decimal"
			min={min}
			aria-label={label}
			placeholder={placeholder}
			className="w-16 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
			value={text}
			onChange={(e) => {
				setText(e.target.value);
				const n = e.target.value.trim() === "" ? null : Number(e.target.value);
				if (n === null || (Number.isFinite(n) && n >= min)) {
					onCommit(n);
				}
			}}
		/>
	);
}

const DEFAULT_WITHIN: AddedRule = { kind: "within", amount: 30, unit: "days" };

function AddedControl({
	value,
	onChange,
}: {
	value: AddedRule | null;
	onChange: (next: AddedRule | null) => void;
}) {
	return (
		<>
			<Picker
				label="When the song was added"
				value={addedKind(value)}
				options={ADDED_OPTIONS}
				onChange={(kind) =>
					onChange(
						kind === "within" && value === null ? DEFAULT_WITHIN : withAddedKind(value, kind),
					)
				}
			/>
			{value?.kind === "within" && (
				<>
					<NumberBox
						label="How many"
						min={1}
						value={value.amount}
						onCommit={(n) => n !== null && onChange({ ...value, amount: Math.round(n) })}
					/>
					<Picker
						label="Days, weeks or months"
						value={value.unit}
						options={UNIT_OPTIONS}
						onChange={(unit) => onChange({ ...value, unit })}
					/>
				</>
			)}
			{(value?.kind === "after" || value?.kind === "before") && (
				<Input
					type="date"
					aria-label="Date"
					className="w-auto"
					value={dateInput(value.date)}
					onChange={(e) => {
						const date = fromDateInput(e.target.value);
						if (date !== null) {
							onChange({ ...value, date });
						}
					}}
				/>
			)}
		</>
	);
}

const SUGGESTIONS = 8;

/** The library's biggest tags, one click each, while a new playlist has none yet. */
function Suggestions({ onPick }: { onPick: (name: string) => void }) {
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const top = [...(tags.data ?? [])]
		.filter((t) => t.trackCount > 0)
		.sort((a, b) => b.trackCount - a.trackCount)
		.slice(0, SUGGESTIONS);
	if (top.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5 pl-3.5">
			<span className="text-muted-foreground text-xs">Your biggest tags:</span>
			{top.map((t) => (
				<button
					key={t.id}
					type="button"
					onClick={() => onPick(t.name)}
					className="rounded-md border px-2 py-0.5 text-xs transition-colors hover:border-primary/50 hover:bg-primary/5"
				>
					{tagLeaf(t.name)}
				</button>
			))}
		</div>
	);
}

/** Colour and icon of each kind of rule, shared by the form and the sentence that reads it back. */
const TAG_LOOK: Record<TagRole, { icon: LucideIcon; text: string }> = {
	all: { icon: TagIcon, text: "text-primary" },
	any: { icon: TagIcon, text: "text-primary" },
	none: { icon: Ban, text: "text-destructive" },
};

const DEVICE_ONLY_NOTE =
	"Counts when a song reached this device. Other devices sharing this playlist count their own, so they can list different songs.";

const FILTER_LOOK: Record<FilterKind, { icon: LucideIcon; text: string; label: string }> = {
	added: { icon: CalendarClock, text: "text-warning", label: "Added" },
	bpm: { icon: Metronome, text: "text-success", label: "Tempo" },
};

/** A word of the sentence that stands for a rule: its icon and colour, kept on one line. */
function RuleWord({
	icon: Icon,
	className,
	title,
	children,
}: {
	icon: LucideIcon;
	className: string;
	title?: string | undefined;
	children: ReactNode;
}) {
	return (
		<span className={cn("whitespace-nowrap font-medium", className)} title={title}>
			<Icon className="-mt-0.5 mr-1 inline size-3.5" aria-hidden="true" />
			{children}
		</span>
	);
}

function SentencePart({ part }: { part: Part }) {
	if ("tag" in part) {
		const look = TAG_LOOK[part.role];
		return (
			<RuleWord icon={look.icon} className={look.text} title={part.tag}>
				{ruleTagLabel(part.tag)}
			</RuleWord>
		);
	}
	if ("filter" in part) {
		const look = FILTER_LOOK[part.filter];
		return (
			<RuleWord
				icon={look.icon}
				className={look.text}
				title={DEVICE_ONLY_FILTERS[part.filter] ? DEVICE_ONLY_NOTE : undefined}
			>
				{part.text}
			</RuleWord>
		);
	}
	return <span>{part.text}</span>;
}

/** The rules in words and what they add up to: the first thing to read, kept in step with edits. */
export function Readout({
	rules,
	preview,
}: {
	rules: SmartRules;
	preview: SmartPreview | undefined;
}) {
	return (
		<div className="space-y-1">
			<p className="text-pretty text-sm">
				{describeParts(rules).map((p, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the sentence is rebuilt whole
					<SentencePart key={i} part={p} />
				))}
			</p>
			<p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
				{preview === undefined
					? "Counting songs…"
					: `${plural(preview.trackIds.length, "song")}, ${duration(preview.durationMs / 1000)}, ${formatBytes(preview.bytes)}`}
				{preview && preview.undated > 0 && (
					<>
						{". "}
						{plural(preview.undated, "more song")} {preview.undated === 1 ? "matches" : "match"} but{" "}
						{preview.undated === 1 ? "has" : "have"} no added date
					</>
				)}
			</p>
		</div>
	);
}

interface SectionProps {
	rules: SmartRules;
	setRules: (next: SmartRules) => void;
}

/** The three tag groups, always shown; an empty group asks nothing of a song. */
function TagSection({ rules, setRules }: SectionProps) {
	const noTags = rules.allTags.length + rules.anyTags.length + rules.noneTags.length === 0;
	return (
		<section className="space-y-2">
			<h3 className={typeScale.sectionTitle}>Tags</h3>
			<TagGroup
				group="all"
				rules={rules}
				setRules={setRules}
				placeholder="Search your tags, e.g. instrumental"
			/>
			{noTags && <Suggestions onPick={(tag) => setRules(placeTag(rules, tag, "all"))} />}
			<AndRule />
			<TagGroup group="any" rules={rules} setRules={setRules} placeholder="e.g. house, techno" />
			<AndRule />
			<TagGroup group="none" rules={rules} setRules={setRules} placeholder="e.g. vocal" />
			<p className="pt-1 text-muted-foreground text-xs">
				Empty groups are ignored. A tag also covers the tags under it, so Genre covers Genre ›
				House.
			</p>
		</section>
	);
}

function FilterSection({ rules, setRules }: SectionProps) {
	return (
		<section className="space-y-2.5">
			<h3 className={typeScale.sectionTitle}>Filters</h3>
			<FilterRow
				kind="added"
				onClear={rules.added === null ? undefined : () => setRules({ ...rules, added: null })}
			>
				<AddedControl value={rules.added} onChange={(added) => setRules({ ...rules, added })} />
			</FilterRow>
			<FilterRow
				kind="bpm"
				onClear={
					rules.bpmMin === null && rules.bpmMax === null
						? undefined
						: () => setRules({ ...rules, bpmMin: null, bpmMax: null })
				}
			>
				<NumberBox
					label="Lowest BPM"
					placeholder="Any"
					value={rules.bpmMin}
					onCommit={(bpmMin) => setRules({ ...rules, bpmMin })}
				/>
				<span className="text-muted-foreground text-sm">to</span>
				<NumberBox
					label="Highest BPM"
					placeholder="Any"
					value={rules.bpmMax}
					onCommit={(bpmMax) => setRules({ ...rules, bpmMax })}
				/>
				<span className="text-muted-foreground text-sm">BPM</span>
			</FilterRow>
		</section>
	);
}

/**
 * A smart playlist's rules, saved as they change. Until the playlist is renamed by hand its name
 * follows the tags, so "instrumental" + "House" names itself.
 */
export function SmartRulesEditor({ playlist }: { playlist: SmartPlaylist }) {
	const queryClient = useQueryClient();
	const [rules, setRules] = useState(playlist.rules);
	const refresh = useRefreshItems();
	/** Rules that would put a local tag in a shared playlist, waiting for the user's choice. */
	const [asking, setAsking] = useState<{ next: SmartRules; tags: LocalTagUse[] } | null>(null);
	const [askError, setAskError] = useState<string | null>(null);
	const change = async (next: SmartRules) => {
		if (playlist.scope === "local") {
			setRules(next);
			return;
		}
		const tags = await smartLocalTags(next);
		if (tags.length === 0) {
			setRules(next);
		} else {
			setAskError(null);
			setAsking({ next, tags });
		}
	};
	const settle = async (choices: Record<string, "share" | "remove">) => {
		if (!asking) {
			return;
		}
		try {
			let next = asking.next;
			for (const t of asking.tags) {
				if (choices[t.tag] === "share") {
					await shareItem("tag", t.id);
				} else {
					next = removeTag(next, t.tag);
				}
			}
			await refresh();
			setRules(next);
			setAsking(null);
		} catch (e) {
			setAskError(String(e));
		}
	};
	const latest = useRef(playlist);
	latest.current = playlist;
	const autosave = useAutosave({
		label: `Rules of “${playlist.name}”`,
		value: rules,
		saved: playlist.rules,
		equal: sameRules,
		save: async (next) => {
			const now = latest.current;
			const named = now.name !== autoName(now.rules);
			const stored = await saveSmartPlaylist({
				...now,
				rules: next,
				name: named ? now.name : autoName(next),
			});
			queryClient.setQueryData<SmartPlaylist[]>(SMART_KEY, (old) =>
				(old ?? []).map((p) => (p.id === stored.id ? stored : p)),
			);
		},
	});
	const settled = useDebounced(rules, 250);
	const preview = useSmartPreview(settled);
	return (
		<div className="max-w-3xl space-y-6">
			<div className="flex items-start justify-between gap-4">
				<Readout rules={rules} preview={preview.data} />
				<SaveState status={autosave.status} error={autosave.error} />
			</div>
			<TagSection rules={rules} setRules={(next) => void change(next)} />
			<FilterSection rules={rules} setRules={setRules} />
			{preview.isError && <ErrorLine>{String(preview.error)}</ErrorLine>}
			{asking && (
				<LocalTagsDialog
					title={`“${playlist.name}” is shared. Use local tags in it?`}
					tags={asking.tags}
					confirmLabel="Use in shared playlist"
					onCancel={() => setAsking(null)}
					onConfirm={(choices) => void settle(choices)}
				/>
			)}
			{askError && <ErrorLine>{askError}</ErrorLine>}
		</div>
	);
}
