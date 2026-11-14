import { useQuery } from "@tanstack/react-query";
import { Check, Merge, Pencil, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { ErrorText } from "#/components/error-text.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { listTags } from "#/lib/api.ts";
import { useTagDatabaseOps, useTagValues } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

const SOURCES = [
	{ id: "artist", label: "Artists" },
	{ id: "albumArtist", label: "Album artists" },
	{ id: "genre", label: "Genres" },
	{ id: "label", label: "Labels" },
	{ id: "grouping", label: "Grouping" },
	{ id: "composer", label: "Composers" },
	{ id: "remixer", label: "Remixers" },
	{ id: "mood", label: "Moods" },
	{ id: "language", label: "Languages" },
	{ id: "library", label: "Library tags" },
] as const;

interface Item {
	value: string;
	count: number;
}

/** A change waiting for the user's go-ahead. `to` of `null` deletes. */
interface Pending {
	from: string[];
	to: string | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function useItems(source: string): { items: Item[]; loading: boolean } {
	const isLibrary = source === "library";
	const values = useTagValues(source, !isLibrary);
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags, enabled: isLibrary });
	const items = useMemo<Item[]>(
		() =>
			isLibrary
				? (tags.data ?? []).map((t) => ({ value: t.name, count: t.trackCount }))
				: [...(values.data ?? [])].sort((a, b) => a.value.localeCompare(b.value)),
		[isLibrary, tags.data, values.data],
	);
	return { items, loading: isLibrary ? tags.isPending : values.isPending };
}

/** Browse, create, rename, merge and delete the values used across the library. */
export function TagDatabase() {
	const [source, setSource] = useState<string>("artist");
	const { items, loading } = useItems(source);
	const ops = useTagDatabaseOps(source);
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [editing, setEditing] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const busy = ops.migrate.isPending || ops.create.isPending;
	const isLibrary = source === "library";

	// A different list starts clean.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the source changes
	useEffect(() => {
		setSelected(new Set());
		setEditing(null);
		setPending(null);
		setSearch("");
		setNotice(null);
	}, [source]);

	const shown = useMemo(() => {
		const q = search.trim().toLowerCase();
		return q === "" ? items : items.filter((i) => i.value.toLowerCase().includes(q));
	}, [items, search]);
	const countOf = (names: string[]) =>
		items.filter((i) => names.some((n) => same(n, i.value))).reduce((sum, i) => sum + i.count, 0);

	const toggle = (value: string) =>
		setSelected((s) => {
			const next = new Set(s);
			if (!next.delete(value)) {
				next.add(value);
			}
			return next;
		});

	const create = async (name: string) => {
		setNotice(null);
		try {
			await ops.create.mutateAsync(name);
			setNotice({ ok: true, text: `Added “${name}”.` });
		} catch (e) {
			setNotice({ ok: false, text: String(e) });
		}
	};

	const run = async (p: Pending) => {
		setPending(null);
		setNotice(null);
		try {
			const report = await ops.migrate.mutateAsync(p);
			const failed = report?.failed.length ?? 0;
			setSelected(new Set());
			setEditing(null);
			setNotice(
				failed === 0
					? {
							ok: true,
							text: report ? `Updated ${plural(report.fixed, "song", "songs")}.` : "Done.",
						}
					: {
							ok: false,
							text: `${report?.fixed ?? 0} updated, ${failed} failed: ${report?.failed[0]?.error ?? ""}`,
						},
			);
		} catch (e) {
			setNotice({ ok: false, text: String(e) });
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap gap-1.5">
				{SOURCES.map((s) => (
					<button
						key={s.id}
						type="button"
						onClick={() => setSource(s.id)}
						className={cn(
							"rounded-full border px-3 py-1 text-sm transition-colors",
							source === s.id
								? "border-primary bg-primary text-primary-foreground"
								: "text-muted-foreground hover:bg-muted hover:text-foreground",
						)}
					>
						{s.label}
					</button>
				))}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<Input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search…"
					aria-label="Search values"
					className="max-w-xs"
				/>
				<NewValue busy={busy} existing={items} onCreate={create} />
				<span className="ml-auto text-muted-foreground text-xs">
					{plural(items.length, "value", "values")}
				</span>
			</div>

			{selected.size > 0 && (
				<MigrateBar
					selected={[...selected]}
					items={items}
					busy={busy}
					onClear={() => setSelected(new Set())}
					onMigrate={(to) => setPending({ from: [...selected], to })}
				/>
			)}

			{notice && (
				<p className={cn("text-sm", notice.ok ? "text-muted-foreground" : "text-destructive")}>
					{notice.text}
				</p>
			)}
			{(ops.migrate.isError || ops.create.isError) && (
				<ErrorText
					message={String(ops.migrate.error ?? ops.create.error)}
					className="text-destructive text-sm"
				/>
			)}

			<div className="divide-y rounded-lg border">
				{loading && <p className="p-4 text-muted-foreground text-sm">Loading…</p>}
				{!loading && shown.length === 0 && (
					<p className="p-4 text-muted-foreground text-sm">
						{items.length === 0 ? "Nothing here yet." : "No match."}
					</p>
				)}
				{shown.map((item) => (
					<Row
						key={item.value}
						item={item}
						unit={isLibrary ? "tracks" : "songs"}
						checked={selected.has(item.value)}
						editing={editing === item.value}
						busy={busy}
						onToggle={() => toggle(item.value)}
						onEdit={() => setEditing(item.value)}
						onCancel={() => setEditing(null)}
						onRename={(to) =>
							same(to, item.value) && to === item.value
								? setEditing(null)
								: setPending({ from: [item.value], to })
						}
						onDelete={() => setPending({ from: [item.value], to: null })}
					/>
				))}
			</div>

			{pending && (
				<Confirm
					pending={pending}
					affected={countOf(pending.from)}
					merge={
						pending.to !== null &&
						items.some((i) => same(i.value, pending.to ?? "") && !pending.from.includes(i.value))
					}
					rewritesFiles={!isLibrary}
					onCancel={() => setPending(null)}
					onConfirm={() => run(pending)}
				/>
			)}
		</div>
	);
}

function NewValue({
	busy,
	existing,
	onCreate,
}: {
	busy: boolean;
	existing: Item[];
	onCreate: (name: string) => void;
}) {
	const [name, setName] = useState("");
	const trimmed = name.trim();
	const taken = existing.some((i) => same(i.value, trimmed));
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (trimmed !== "" && !taken) {
			onCreate(trimmed);
			setName("");
		}
	};
	return (
		<form onSubmit={submit} className="flex gap-2">
			<Input
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="New value…"
				aria-label="New value"
				className="w-48"
			/>
			<Button type="submit" variant="outline" disabled={busy || trimmed === "" || taken}>
				<Plus /> Create
			</Button>
		</form>
	);
}

function MigrateBar({
	selected,
	items,
	busy,
	onClear,
	onMigrate,
}: {
	selected: string[];
	items: Item[];
	busy: boolean;
	onClear: () => void;
	onMigrate: (to: string | null) => void;
}) {
	const listId = useId();
	const [target, setTarget] = useState("");
	const to = target.trim();
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2">
			<span className="px-1 font-medium text-sm">{selected.length} selected</span>
			<Input
				value={target}
				onChange={(e) => setTarget(e.target.value)}
				list={listId}
				placeholder="Move all into…"
				aria-label="Move selected into"
				className="w-56"
			/>
			<datalist id={listId}>
				{items
					.filter((i) => !selected.includes(i.value))
					.map((i) => (
						<option key={i.value} value={i.value} />
					))}
			</datalist>
			<Button onClick={() => onMigrate(to)} disabled={busy || to === ""}>
				<Merge /> Migrate
			</Button>
			<Button variant="destructive" onClick={() => onMigrate(null)} disabled={busy}>
				<Trash2 /> Delete
			</Button>
			<Button variant="ghost" onClick={onClear} className="ml-auto">
				Clear
			</Button>
		</div>
	);
}

function Row({
	item,
	unit,
	checked,
	editing,
	busy,
	onToggle,
	onEdit,
	onCancel,
	onRename,
	onDelete,
}: {
	item: Item;
	unit: string;
	checked: boolean;
	editing: boolean;
	busy: boolean;
	onToggle: () => void;
	onEdit: () => void;
	onCancel: () => void;
	onRename: (to: string) => void;
	onDelete: () => void;
}) {
	const [text, setText] = useState(item.value);
	useEffect(() => {
		if (editing) {
			setText(item.value);
		}
	}, [editing, item.value]);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (text.trim() !== "") {
			onRename(text.trim());
		}
	};
	return (
		<div className={cn("flex items-center gap-3 px-3 py-1.5", checked && "bg-primary/5")}>
			<input
				type="checkbox"
				checked={checked}
				onChange={onToggle}
				aria-label={`Select ${item.value}`}
				className="size-4 accent-primary"
			/>
			{editing ? (
				<form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-1.5">
					<Input
						autoFocus
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && onCancel()}
						aria-label={`Rename ${item.value}`}
					/>
					<Button type="submit" size="icon" aria-label="Apply rename" disabled={busy}>
						<Check />
					</Button>
					<Button type="button" size="icon" variant="ghost" aria-label="Cancel" onClick={onCancel}>
						<X />
					</Button>
				</form>
			) : (
				<>
					<span className="min-w-0 flex-1 truncate text-sm" title={item.value}>
						{item.value}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						{item.count === 0 ? "unused" : `${item.count} ${unit}`}
					</span>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={`Rename ${item.value}`}
						onClick={onEdit}
						disabled={busy}
					>
						<Pencil />
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={`Delete ${item.value}`}
						onClick={onDelete}
						disabled={busy}
					>
						<Trash2 />
					</Button>
				</>
			)}
		</div>
	);
}

function Confirm({
	pending,
	affected,
	merge,
	rewritesFiles,
	onCancel,
	onConfirm,
}: {
	pending: Pending;
	affected: number;
	merge: boolean;
	rewritesFiles: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);
	const names = pending.from.map((n) => `“${n}”`).join(", ");
	let title: string;
	if (pending.to === null) {
		title = `Delete ${names}`;
	} else if (merge || pending.from.length > 1) {
		title = `Merge ${names} into “${pending.to}”`;
	} else {
		title = `Rename ${names} to “${pending.to}”`;
	}
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div
				aria-hidden="true"
				onMouseDown={onCancel}
				className="absolute inset-0 bg-background/60 backdrop-blur-sm"
			/>
			<div
				role="dialog"
				aria-label={title}
				className="relative w-[28rem] max-w-[calc(100%-2rem)] space-y-3 rounded-xl border bg-background p-4 shadow-2xl"
			>
				<div className="break-words font-medium text-sm">{title}</div>
				<p className="text-muted-foreground text-sm">
					{affected === 0
						? "No song uses this yet."
						: `Changes up to ${plural(affected, "song", "songs")}.`}
					{rewritesFiles && affected > 0 && " The tags inside the audio files are rewritten."}
					{pending.to === null && affected > 0 && " The value is removed from each of them."}
				</p>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						variant={pending.to === null ? "destructive" : "default"}
						onClick={onConfirm}
						autoFocus
					>
						{pending.to === null ? "Delete" : "Apply"}
					</Button>
				</div>
			</div>
		</div>
	);
}
