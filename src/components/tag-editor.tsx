import {
	ChevronRight,
	Eraser,
	File as FileIcon,
	Folder,
	TextCursorInput,
	Undo2,
	X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { CoverPicker } from "#/components/cover-picker.tsx";
import { NameSplitPills } from "#/components/name-split-pill.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PropertyRow } from "#/components/property-row.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { type ComboOption, TagCombobox } from "#/components/tag-combobox.tsx";
import { SuggestionPill, TagLookupStrip } from "#/components/tag-lookup-strip.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { pathArtUrl, type TagValue, type TagView } from "#/lib/api.ts";
import { useArtVersion } from "#/lib/art-version.ts";
import { useTagsRead, useTagsWrite, useTagValues } from "#/lib/queries.ts";
import { TAG_GROUPS, type TagField, type TagGroup } from "#/lib/tag-fields.ts";
import { fillFromPath } from "#/lib/tag-fill.ts";
import { type SaveStatus, useAutosave } from "#/lib/unsaved.tsx";
import { type TagSuggestions, useTagSuggestions } from "#/lib/use-tag-suggestions.ts";
import { cn } from "#/lib/utils.ts";

export interface TagTarget {
	/** The song or folder; for a group of songs, its first song (used for the cover). */
	path: string;
	name: string;
	/** True for a folder or a group of songs: only fields that suit many songs are offered. */
	isDir: boolean;
	/** Set to edit a group of songs (an album, a selection) instead of `path`. */
	paths?: readonly string[] | undefined;
	/** What the group is, for the header ("Album", "Selection"). */
	kind?: string | undefined;
}

/** What the editor reads and writes. */
const where = (t: TagTarget) => t.paths ?? t.path;

type Shared = TagView["fields"][string];
type Draft = Record<string, string>;

const sameDraft = (a: Draft, b: Draft) => {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** What a tag write did, when worth saying: only failures. */
function noticeFor(report: {
	fixed: number;
	failed: readonly { error: string }[];
}): { ok: boolean; text: string } | null {
	const failed = report.failed.length;
	if (failed === 0) {
		return null;
	}
	return {
		ok: false,
		text: `${report.fixed} saved, ${failed} failed: ${report.failed[0]?.error ?? ""}`,
	};
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Groups opened by default; the rest open when they hold something or on demand. */
const OPEN_BY_DEFAULT = new Set(["Core", "Numbering", "DJ"]);

/**
 * Edits tags of one song, or of every song under a folder (only fields that make sense for a
 * whole folder are offered). Only fields you touch are written; the rest stay as they are.
 */
export function TagEditor({
	target,
	onClose,
	embedded = false,
}: {
	target: TagTarget;
	/** Shows a close button in the header, where nothing around the editor closes it. */
	onClose?: (() => void) | undefined;
	/** Sits inside a page that scrolls and names the song: no header or own scrolling. */
	embedded?: boolean;
}) {
	const view = useTagsRead(where(target));
	const write = useTagsWrite();
	// Only edited fields live here; an empty string means "clear this field".
	const [draft, setDraft] = useState<Draft>({});
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const count = view.data?.count ?? 0;

	const edit = (id: string, value: string) => {
		setNotice(null);
		setDraft((d) => ({ ...d, [id]: value }));
	};
	const revert = (id: string) =>
		setDraft((d) => {
			const { [id]: _gone, ...rest } = d;
			return rest;
		});

	// Edits save on their own a second after the last one, for one song or many.
	const writeNow = async (edits: Draft) => {
		setNotice(null);
		const report = await write.mutateAsync({ path: where(target), edits });
		const failed = report.failed.length;
		if (failed > 0 && report.fixed === 0) {
			throw new Error(report.failed[0]?.error ?? "could not write the tags");
		}
		// Only what was written: edits typed while saving stay to be saved next.
		setDraft((d) =>
			Object.fromEntries(Object.entries(d).filter(([id, value]) => edits[id] !== value)),
		);
		setNotice(noticeFor(report));
	};
	const autosave = useAutosave({
		label: `Metadata of "${target.name}"`,
		value: draft,
		saved: {},
		equal: sameDraft,
		save: writeNow,
	});

	// The lookup searches with the tags in the files, so pending edits are saved first.
	const found = useTagSuggestions(where(target), target.isDir, () => autosave.flush());

	// Cmd+S, or Cmd+Enter in a field, saves right away instead of waiting out the second.
	const onKeyDown = (ev: KeyboardEvent) => {
		if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			void autosave.flush();
		}
	};
	const flushRef = useRef(autosave.flush);
	flushRef.current = autosave.flush;
	useEffect(() => {
		const onKey = (ev: globalThis.KeyboardEvent) => {
			if (ev.key.toLowerCase() !== "s" || !(ev.metaKey || ev.ctrlKey) || ev.shiftKey) {
				return;
			}
			ev.preventDefault();
			if (!document.querySelector("[role=dialog]")) {
				void flushRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Cmd+Enter applies from any field
		<div
			className={cn("flex flex-col", embedded ? "-mx-5" : "min-h-0 flex-1")}
			onKeyDown={onKeyDown}
		>
			{!embedded && <Header target={target} count={view.data ? count : null} onClose={onClose} />}
			<div className={cn(!embedded && "min-h-0 flex-1 overflow-y-auto")}>
				{count > 0 && <TagLookupStrip found={found} />}
				<Body
					view={view}
					target={target}
					draft={draft}
					found={found}
					onEdit={edit}
					onRevert={revert}
				/>
			</div>
			<Footer notice={notice} autosave={autosave} />
		</div>
	);
}

/** Where saving stands; the status bar says when. Only a failed write shows here. */
function Footer({
	notice,
	autosave,
}: {
	notice: { ok: boolean; text: string } | null;
	autosave: { status: SaveStatus; error: string | null };
}) {
	return (
		<>
			<SaveState status={autosave.status} error={autosave.error} />
			{notice && !notice.ok && (
				<ErrorLine className="border-t px-3 py-2.5">{notice.text}</ErrorLine>
			)}
		</>
	);
}

/** The shared header for the editor in the drawer: cover (click to replace), name, what it holds. */
function Header({
	target,
	count,
	onClose,
}: {
	target: TagTarget;
	count: number | null;
	onClose: (() => void) | undefined;
}) {
	const [artFailed, setArtFailed] = useState(false);
	const artVersion = useArtVersion();
	const Icon = target.isDir ? Folder : FileIcon;
	let what = target.isDir ? "Folder" : "Song";
	if (target.paths) {
		what = `${target.kind ?? "Selection"}${count === null ? "" : `, ${plural(count, "song", "songs")}`}`;
	} else if (target.isDir && count !== null) {
		what = `Folder, ${plural(count, "song", "songs")}, subfolders included`;
	}
	return (
		<div className="border-b bg-card/40 px-5 pt-6 pb-5">
			<PageHeader
				variant="plain"
				art={
					<CoverPicker paths={where(target)} name={target.name} className="size-24 shrink-0">
						{artFailed ? (
							<span className="grid size-24 place-items-center rounded-lg bg-muted text-muted-foreground">
								<Icon className="size-8" />
							</span>
						) : (
							<img
								key={`${target.path}:${artVersion}`}
								src={`${pathArtUrl(target.path)}?v=${artVersion}`}
								alt=""
								draggable={false}
								onError={() => setArtFailed(true)}
								className="size-24 rounded-lg bg-muted object-cover shadow-lg ring-1 ring-foreground/10"
							/>
						)}
					</CoverPicker>
				}
				kind={
					<>
						<TextCursorInput /> Edit metadata
					</>
				}
				badge={
					onClose && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Close metadata editor"
							onClick={onClose}
						>
							<X />
						</Button>
					)
				}
				title={
					<h1 className="truncate font-semibold text-2xl tracking-tight" title={target.name}>
						{target.name}
					</h1>
				}
				meta={<span>{what}</span>}
			/>
		</div>
	);
}

function Body({
	view,
	target,
	draft,
	found,
	onEdit,
	onRevert,
}: {
	view: ReturnType<typeof useTagsRead>;
	target: TagTarget;
	draft: Draft;
	found: TagSuggestions;
	onEdit: (id: string, value: string) => void;
	onRevert: (id: string) => void;
}) {
	if (view.isPending) {
		return <p className="p-4 text-muted-foreground text-sm">Reading metadata…</p>;
	}
	if (view.isError) {
		return <ErrorLine className="p-4">{String(view.error)}</ErrorLine>;
	}
	if (view.data.count === 0) {
		return (
			<p className="p-4 text-muted-foreground text-sm">
				No songs here. Select a song, or a folder that contains songs.
			</p>
		);
	}
	return (
		<div className="divide-y">
			{TAG_GROUPS.map((group) => (
				<Group
					key={group.title}
					group={group}
					target={target}
					fields={view.data.fields}
					isDir={target.isDir}
					draft={draft}
					found={found}
					onEdit={onEdit}
					onRevert={onRevert}
				/>
			))}
		</div>
	);
}

function Group({
	group,
	target,
	fields,
	isDir,
	draft,
	found,
	onEdit,
	onRevert,
}: {
	group: TagGroup;
	target: TagTarget;
	fields: Record<string, Shared>;
	isDir: boolean;
	draft: Draft;
	found: TagSuggestions;
	onEdit: (id: string, value: string) => void;
	onRevert: (id: string) => void;
}) {
	const shown = group.fields.filter((f) => !isDir || f.scope === "both");
	if (shown.length === 0) {
		return null;
	}
	const filled = shown.filter((f) => fields[f.id]?.value || fields[f.id]?.mixed).length;
	const changed = shown.filter((f) => draft[f.id] !== undefined).length;
	const suggested = shown.filter((f) => found.inline.has(f.id)).length;
	return (
		<details
			open={OPEN_BY_DEFAULT.has(group.title) || filled > 0 || changed > 0 || suggested > 0}
			className="group"
		>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
				<span className="font-medium">{group.title}</span>
				<span className="ml-auto text-muted-foreground text-xs">
					{suggested > 0 && <span className="mr-2 text-success">{suggested} found</span>}
					{changed > 0 ? (
						<span className="text-primary">{plural(changed, "change", "changes")}</span>
					) : (
						`${filled} of ${shown.length} set`
					)}
				</span>
			</summary>
			<div className="space-y-px px-3 pt-0.5 pb-3">
				{shown.map((f) => {
					const suggestion = found.inline.get(f.id);
					return (
						<FieldInput
							key={f.id}
							field={f}
							fill={fillFromPath(f.id, target)}
							shared={fields[f.id]}
							draft={draft[f.id]}
							onChange={(v) => onEdit(f.id, f.kind === "number" ? v.replace(/[^\d]/g, "") : v)}
							onRevert={() => onRevert(f.id)}
							found={
								suggestion && (
									<SuggestionPill
										suggestion={suggestion}
										group={isDir}
										disabled={found.writing}
										onTake={() => found.take(suggestion)}
									/>
								)
							}
						/>
					);
				})}
			</div>
		</details>
	);
}

interface FieldProps {
	field: TagField;
	/** Value this field can be filled with from the file / folder name, if any. */
	fill: { value: string; from: string } | null;
	shared: Shared | undefined;
	draft: string | undefined;
	onChange: (v: string) => void;
	onRevert: () => void;
	/** A value a lookup found for this field, shown under it until it is used. */
	found?: ReactNode;
}

/**
 * One field as a single row: its name, then the value, which looks like plain text until hovered
 * or focused. Edited fields are marked in the accent colour with an undo at the end.
 */
function FieldInput(props: FieldProps) {
	const { field, draft, onRevert, fill, shared, onChange, found } = props;
	const id = useId();
	const touched = draft !== undefined;
	const canFill =
		fill !== null &&
		!(touched ? draft === fill.value : shared?.value === fill.value && !shared?.mixed);
	return (
		<PropertyRow
			label={
				<>
					<label
						htmlFor={id}
						title={field.hint ?? field.label}
						className={cn(
							"truncate text-xs",
							touched ? "font-medium text-primary" : "text-muted-foreground",
						)}
					>
						{field.label}
					</label>
					{canFill && (
						<button
							type="button"
							onClick={() => onChange(fill.value)}
							aria-label={`Copy ${field.label} from ${fill.from}`}
							title={`Copy from ${fill.from}: ${fill.value}`}
							className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/field:opacity-100"
						>
							<TextCursorInput className="size-3" />
						</button>
					)}
				</>
			}
			end={
				touched && (
					<button
						type="button"
						onClick={onRevert}
						aria-label={`Undo change to ${field.label}`}
						title="Undo change"
						className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<Undo2 className="size-3.5" />
					</button>
				)
			}
		>
			{field.kind === "flag" ? (
				<FlagSelect id={id} {...props} />
			) : (
				<TextWithSplits id={id} {...props} />
			)}
			{found && <div className="mt-0.5 mb-1.5 px-2.5">{found}</div>}
		</PropertyRow>
	);
}

/** Field chrome that only shows on hover and focus, so a column of values reads as a list. */
const QUIET =
	"min-h-7 h-auto border-transparent bg-transparent dark:bg-transparent hover:border-input focus-visible:border-ring focus-within:border-ring";

function FlagSelect({ id, shared, draft, onChange, onRevert }: FieldProps & { id: string }) {
	const mixed = shared?.mixed ?? false;
	const touched = draft !== undefined;
	let value = shared?.value ? "1" : "";
	if (touched) {
		value = draft;
	} else if (mixed) {
		value = "mixed";
	}
	return (
		<select
			id={id}
			value={value}
			onChange={(e) => (e.target.value === "mixed" ? onRevert() : onChange(e.target.value))}
			className={cn(
				"h-7 w-full rounded-lg border px-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
				touched ? "border-primary/60 bg-primary/5 dark:bg-primary/10" : QUIET,
			)}
		>
			{mixed && !touched && <option value="mixed">Differs between songs</option>}
			<option value="">No</option>
			<option value="1">Yes</option>
		</select>
	);
}

function placeholderFor(shared: Shared | undefined, touched: boolean): string {
	if (touched) {
		return "Will be cleared";
	}
	return shared?.mixed ? "Differs between songs" : "";
}

/** The text control, with split suggestions under fields that hold credited names. */
function TextWithSplits(props: FieldProps & { id: string }) {
	const { field, shared, draft, onChange } = props;
	const touched = draft !== undefined;
	const showSplits = field.splitsCredits && (touched || !shared?.mixed);
	return (
		<>
			<TextControl {...props} />
			{showSplits && (
				<NameSplitPills value={touched ? draft : (shared?.value ?? "")} onChange={onChange} />
			)}
		</>
	);
}

function TextControl(props: FieldProps & { id: string }) {
	return props.field.pick ? <PickControl {...props} /> : <PlainControl {...props} />;
}

function PickControl({ id, field, shared, draft, onChange }: FieldProps & { id: string }) {
	const touched = draft !== undefined;
	const known = useTagValues(field.id, true);
	const placeholder = placeholderFor(shared, touched);
	return (
		<TagCombobox
			id={id}
			value={touched ? draft : (shared?.value ?? "")}
			options={pickOptions(known.data, field)}
			multi={Boolean(field.multi)}
			placeholder={placeholder || (field.multi ? "Add…" : "Search or type…")}
			touched={touched}
			onChange={onChange}
			className={touched ? "min-h-7 py-0.5" : `${QUIET} py-0.5`}
		/>
	);
}

function PlainControl({ id, field, shared, draft, onChange }: FieldProps & { id: string }) {
	const listId = `${id}-list`;
	const touched = draft !== undefined;
	const hasValue = Boolean(shared?.mixed || shared?.value);
	return (
		<div className="relative">
			<Input
				id={id}
				value={touched ? draft : (shared?.value ?? "")}
				placeholder={placeholderFor(shared, touched)}
				list={field.suggestions ? listId : undefined}
				inputMode={field.kind === "number" ? "numeric" : undefined}
				onChange={(e) => onChange(e.target.value)}
				className={cn(
					"h-7 px-1.5",
					touched ? "border-primary/60 bg-primary/5 dark:bg-primary/10" : QUIET,
					hasValue && !touched && "pr-8",
				)}
			/>
			{field.suggestions && (
				<datalist id={listId}>
					{field.suggestions.map((s) => (
						<option key={s} value={s} />
					))}
				</datalist>
			)}
			{hasValue && !touched && (
				<button
					type="button"
					aria-label={`Clear ${field.label}`}
					title="Clear this field"
					onClick={() => onChange("")}
					className="absolute inset-y-0 right-1 my-auto flex size-5 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/field:opacity-100"
				>
					<Eraser className="size-3.5" />
				</button>
			)}
		</div>
	);
}

/** Library values first (most used), then built-in suggestions (e.g. common genres). */
function pickOptions(known: readonly TagValue[] | undefined, field: TagField): ComboOption[] {
	const out: ComboOption[] = (known ?? []).map((k) => ({ value: k.value, count: k.count }));
	const seen = new Set(out.map((o) => o.value.toLowerCase()));
	for (const s of field.suggestions ?? []) {
		if (!seen.has(s.toLowerCase())) {
			out.push({ value: s, count: 0 });
		}
	}
	return out;
}
