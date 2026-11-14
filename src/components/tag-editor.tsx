import { ChevronRight, Eraser, File as FileIcon, Folder, ImagePlus, Undo2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ErrorText } from "#/components/error-text.tsx";
import { type ComboOption, TagCombobox } from "#/components/tag-combobox.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { pathArtUrl, type TagValue, type TagView } from "#/lib/api.ts";
import { useTagsRead, useTagsSetCover, useTagsWrite, useTagValues } from "#/lib/queries.ts";
import { TAG_GROUPS, type TagField, type TagGroup } from "#/lib/tag-fields.ts";
import type { TagConfirmRequest } from "#/lib/use-tag-confirm.tsx";
import { cn } from "#/lib/utils.ts";

export interface TagTarget {
	path: string;
	name: string;
	isDir: boolean;
}

type Shared = TagView["fields"][string];
type Draft = Record<string, string>;

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
	confirm,
}: {
	target: TagTarget;
	onClose: () => void;
	confirm: (req: TagConfirmRequest) => Promise<boolean>;
}) {
	const view = useTagsRead(target.path);
	const write = useTagsWrite();
	// Only edited fields live here; an empty string means "clear this tag".
	const [draft, setDraft] = useState<Draft>({});
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const [artVersion, setArtVersion] = useState(0);
	const count = view.data?.count ?? 0;
	const edited = Object.keys(draft);

	const edit = (id: string, value: string) => {
		setNotice(null);
		setDraft((d) => ({ ...d, [id]: value }));
	};
	const revert = (id: string) =>
		setDraft((d) => {
			const { [id]: _gone, ...rest } = d;
			return rest;
		});

	const save = async () => {
		if (edited.length === 0 || write.isPending) {
			return;
		}
		const ok = await confirm({
			title: target.isDir ? `Apply to all songs in "${target.name}"` : `Apply to "${target.name}"`,
			subtitle: target.isDir ? "Includes subfolders" : undefined,
			items: [{ path: target.path, name: target.name, edits: draft }],
		});
		if (!ok) {
			return;
		}
		setNotice(null);
		write.mutate(
			{ path: target.path, edits: draft },
			{
				onSuccess: (report) => {
					setDraft({});
					const failed = report.failed.length;
					setNotice(
						failed === 0
							? { ok: true, text: `Saved to ${plural(report.fixed, "song", "songs")}.` }
							: {
									ok: false,
									text: `${report.fixed} saved, ${failed} failed: ${report.failed[0]?.error ?? ""}`,
								},
					);
				},
			},
		);
	};

	const onKeyDown = (ev: KeyboardEvent) => {
		if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
			ev.preventDefault();
			void save();
		}
	};

	// Cmd+S saves from anywhere while the editor is open, even with focus in the file list.
	const saveRef = useRef(save);
	saveRef.current = save;
	useEffect(() => {
		const onKey = (ev: globalThis.KeyboardEvent) => {
			if (ev.key.toLowerCase() !== "s" || !(ev.metaKey || ev.ctrlKey) || ev.shiftKey) {
				return;
			}
			ev.preventDefault();
			if (!document.querySelector("[role=dialog]")) {
				void saveRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Cmd+Enter applies from any field
		<div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
			<Header
				target={target}
				count={view.data ? count : null}
				artVersion={artVersion}
				onClose={onClose}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{view.data && count > 0 && (
					<CoverSection
						target={target}
						count={count}
						artVersion={artVersion}
						onSaved={() => setArtVersion((v) => v + 1)}
					/>
				)}
				<Body view={view} target={target} draft={draft} onEdit={edit} onRevert={revert} />
			</div>
			<footer className="flex items-center gap-2 border-t bg-background px-3 py-2.5">
				<Status
					error={write.isError ? String(write.error) : null}
					notice={notice}
					edited={edited.length}
				/>
				<Button variant="ghost" onClick={() => setDraft({})} disabled={edited.length === 0}>
					Discard
				</Button>
				<Button onClick={save} disabled={edited.length === 0 || write.isPending}>
					{write.isPending ? "Saving…" : "Save"}
				</Button>
			</footer>
		</div>
	);
}

function Status({
	error,
	notice,
	edited,
}: {
	error: string | null;
	notice: { ok: boolean; text: string } | null;
	edited: number;
}) {
	let body: React.ReactNode;
	if (error) {
		body = <ErrorText message={error} className="text-destructive" />;
	} else if (notice) {
		body = (
			<span className={notice.ok ? "text-muted-foreground" : "text-destructive"}>
				{notice.text}
			</span>
		);
	} else {
		body = (
			<span className="text-muted-foreground">
				{edited === 0 ? "No changes" : plural(edited, "change", "changes")}
			</span>
		);
	}
	return <div className="min-w-0 flex-1 text-xs">{body}</div>;
}

function Header({
	target,
	count,
	artVersion,
	onClose,
}: {
	target: TagTarget;
	count: number | null;
	artVersion: number;
	onClose: () => void;
}) {
	const [artFailed, setArtFailed] = useState(false);
	const Icon = target.isDir ? Folder : FileIcon;
	let subtitle = target.isDir ? "Folder" : "Song";
	if (target.isDir && count !== null) {
		subtitle = `Folder · ${plural(count, "song", "songs")}, subfolders included`;
	}
	return (
		<div className="flex items-center gap-3 border-b px-3 py-2.5">
			{artFailed ? (
				<span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
					<Icon className="size-5" />
				</span>
			) : (
				<img
					key={`${target.path}:${artVersion}`}
					src={`${pathArtUrl(target.path)}?v=${artVersion}`}
					alt=""
					draggable={false}
					onError={() => setArtFailed(true)}
					className="size-11 shrink-0 rounded-md bg-muted object-cover"
				/>
			)}
			<div className="min-w-0 flex-1">
				<div className="truncate font-medium text-sm" title={target.name}>
					{target.name}
				</div>
				<div className="truncate text-muted-foreground text-xs">{subtitle}</div>
			</div>
			<Button variant="ghost" size="icon" aria-label="Close tags" onClick={onClose}>
				<X />
			</Button>
		</div>
	);
}

const COVER_TYPES = ["image/jpeg", "image/png"];

/** Cover art: choose an image file or paste one; applies to the song, or every song in a folder. */
function CoverSection({
	target,
	count,
	artVersion,
	onSaved,
}: {
	target: TagTarget;
	count: number;
	artVersion: number;
	onSaved: () => void;
}) {
	const setCover = useTagsSetCover();
	const fileInput = useRef<HTMLInputElement>(null);
	const [staged, setStaged] = useState<{ file: Blob; url: string } | null>(null);
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

	useEffect(() => {
		const url = staged?.url;
		return () => {
			if (url) {
				URL.revokeObjectURL(url);
			}
		};
	}, [staged]);

	const stage = (file: Blob | null | undefined) => {
		if (!file) {
			return;
		}
		if (!COVER_TYPES.includes(file.type)) {
			setNotice({ ok: false, text: "Cover must be a JPEG or PNG image." });
			return;
		}
		setNotice(null);
		setStaged({ file, url: URL.createObjectURL(file) });
	};

	// Paste works anywhere in the editor, except while typing in a field.
	useEffect(() => {
		const onPaste = (ev: ClipboardEvent) => {
			const el = ev.target;
			if (el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea"))) {
				return;
			}
			const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
			if (item) {
				ev.preventDefault();
				stage(item.getAsFile());
			}
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
	});

	const apply = async () => {
		if (!staged) {
			return;
		}
		const image = new Uint8Array(await staged.file.arrayBuffer());
		setCover.mutate(
			{ path: target.path, image },
			{
				onSuccess: (report) => {
					const failed = report.failed.length;
					setNotice(
						failed === 0
							? { ok: true, text: `Cover saved to ${plural(report.fixed, "song", "songs")}.` }
							: {
									ok: false,
									text: `${report.fixed} saved, ${failed} failed: ${report.failed[0]?.error ?? ""}`,
								},
					);
					setStaged(null);
					onSaved();
				},
			},
		);
	};

	const shown = staged?.url ?? `${pathArtUrl(target.path)}?v=${artVersion}`;
	return (
		<section className="flex items-center gap-3 border-b px-3 py-3">
			<img
				key={shown}
				src={shown}
				alt=""
				draggable={false}
				onError={(e) => {
					e.currentTarget.style.visibility = "hidden";
				}}
				className="size-24 shrink-0 rounded-md bg-muted object-cover"
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="text-sm font-medium">Cover art</div>
				<div className="text-muted-foreground text-xs">
					{staged
						? target.isDir
							? `Will replace the cover of ${plural(count, "song", "songs")}.`
							: "Will replace this song's cover."
						: "Choose an image, or paste one (Cmd+V). JPEG or PNG."}
				</div>
				{notice && (
					<div className={cn("text-xs", notice.ok ? "text-muted-foreground" : "text-destructive")}>
						{notice.text}
					</div>
				)}
				{setCover.isError && (
					<ErrorText message={String(setCover.error)} className="text-destructive text-xs" />
				)}
				<div className="flex gap-2">
					{staged ? (
						<>
							<Button size="sm" onClick={apply} disabled={setCover.isPending}>
								{setCover.isPending ? "Saving…" : "Apply cover"}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setStaged(null)}
								disabled={setCover.isPending}
							>
								Cancel
							</Button>
						</>
					) : (
						<Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
							<ImagePlus /> Choose image…
						</Button>
					)}
				</div>
				<input
					ref={fileInput}
					type="file"
					accept={COVER_TYPES.join(",")}
					className="hidden"
					onChange={(e) => {
						stage(e.target.files?.[0]);
						e.target.value = "";
					}}
				/>
			</div>
		</section>
	);
}

function Body({
	view,
	target,
	draft,
	onEdit,
	onRevert,
}: {
	view: ReturnType<typeof useTagsRead>;
	target: TagTarget;
	draft: Draft;
	onEdit: (id: string, value: string) => void;
	onRevert: (id: string) => void;
}) {
	if (view.isPending) {
		return <p className="p-4 text-muted-foreground text-sm">Reading tags…</p>;
	}
	if (view.isError) {
		return <ErrorText message={String(view.error)} className="p-4 text-destructive text-sm" />;
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
					fields={view.data.fields}
					isDir={target.isDir}
					draft={draft}
					onEdit={onEdit}
					onRevert={onRevert}
				/>
			))}
		</div>
	);
}

function Group({
	group,
	fields,
	isDir,
	draft,
	onEdit,
	onRevert,
}: {
	group: TagGroup;
	fields: Record<string, Shared>;
	isDir: boolean;
	draft: Draft;
	onEdit: (id: string, value: string) => void;
	onRevert: (id: string) => void;
}) {
	const shown = group.fields.filter((f) => !isDir || f.scope === "both");
	if (shown.length === 0) {
		return null;
	}
	const filled = shown.filter((f) => fields[f.id]?.value || fields[f.id]?.mixed).length;
	const changed = shown.filter((f) => draft[f.id] !== undefined).length;
	return (
		<details open={OPEN_BY_DEFAULT.has(group.title) || filled > 0 || changed > 0} className="group">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
				<span className="font-medium">{group.title}</span>
				<span className="ml-auto text-muted-foreground text-xs">
					{changed > 0 ? (
						<span className="text-primary">{plural(changed, "change", "changes")}</span>
					) : (
						`${filled} of ${shown.length} set`
					)}
				</span>
			</summary>
			<div className="grid grid-cols-2 gap-x-3 gap-y-3 px-3 pt-1 pb-4">
				{shown.map((f) => (
					<FieldInput
						key={f.id}
						field={f}
						shared={fields[f.id]}
						draft={draft[f.id]}
						onChange={(v) => onEdit(f.id, f.kind === "number" ? v.replace(/[^\d]/g, "") : v)}
						onRevert={() => onRevert(f.id)}
					/>
				))}
			</div>
		</details>
	);
}

interface FieldProps {
	field: TagField;
	shared: Shared | undefined;
	draft: string | undefined;
	onChange: (v: string) => void;
	onRevert: () => void;
}

function FieldInput(props: FieldProps) {
	const { field, draft, onRevert } = props;
	const id = useId();
	const touched = draft !== undefined;
	return (
		<div className={field.wide ? "col-span-2" : undefined}>
			<div className="mb-1 flex h-5 items-center gap-1.5">
				<label
					htmlFor={id}
					title={field.hint}
					className={cn("text-xs", touched ? "font-medium text-primary" : "text-muted-foreground")}
				>
					{field.label}
				</label>
				{touched && (
					<button
						type="button"
						onClick={onRevert}
						aria-label={`Undo change to ${field.label}`}
						title="Undo change"
						className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<Undo2 className="size-3" />
					</button>
				)}
			</div>
			{field.kind === "flag" ? (
				<FlagSelect id={id} {...props} />
			) : (
				<TextControl id={id} {...props} />
			)}
		</div>
	);
}

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
			className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
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
					hasValue && !touched && "pr-8",
					touched && "border-primary/60 bg-primary/5 dark:bg-primary/10",
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
					title="Clear this tag"
					onClick={() => onChange("")}
					className="absolute inset-y-0 right-1 my-auto flex size-6 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground"
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
