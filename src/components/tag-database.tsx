import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Merge, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { EmptyState } from "#/components/page.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { type FixReport, listTags, tagValues } from "#/lib/api.ts";
import { useTagDatabaseOps } from "#/lib/queries.ts";
import { VALUE_FIELDS, type ValueField } from "#/lib/track-fields.ts";
import { cn } from "#/lib/utils.ts";

interface Item {
	value: string;
	count: number;
}

/** A change waiting for the user's go-ahead. `to` of `null` deletes. */
interface Pending {
	from: string[];
	to: string | null;
}

interface Order {
	by: "value" | "count";
	desc: boolean;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const byName = (a: Item, b: Item) => a.value.localeCompare(b.value);

const FILE_FIELDS = VALUE_FIELDS.filter((f) => f.id !== "library");

type Lists = Record<ValueField, { items: Item[]; loading: boolean }>;

/** Values of every field at once, so the field list can show how many each has. */
function useAllItems(): Lists {
	const files = useQueries({
		queries: FILE_FIELDS.map((f) => ({
			queryKey: ["tag-values", f.id],
			queryFn: () => tagValues(f.id),
			staleTime: 30_000,
		})),
		combine: (results) =>
			FILE_FIELDS.map((f, i) => ({
				id: f.id,
				items: [...(results[i]?.data ?? [])].sort(byName),
				loading: results[i]?.isPending ?? true,
			})),
	});
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	return useMemo(() => {
		const out = {
			library: {
				items: (tags.data ?? []).map((t) => ({ value: t.name, count: t.trackCount })),
				loading: tags.isPending,
			},
		} as Lists;
		for (const f of files) {
			out[f.id] = { items: f.items, loading: f.loading };
		}
		return out;
	}, [files, tags.data, tags.isPending]);
}

function sorted(items: Item[], order: Order): Item[] {
	const sign = order.desc ? -1 : 1;
	return [...items].sort((a, b) =>
		order.by === "count" ? sign * (a.count - b.count) || byName(a, b) : sign * byName(a, b),
	);
}

/** Browse, create, rename, merge and delete the values used across the library. */
export function TagDatabase() {
	const detail = useDetail();
	const all = useAllItems();
	const [source, setSource] = useState<ValueField>("artist");
	const { items, loading } = all[source];
	const ops = useTagDatabaseOps(source);
	const [search, setSearch] = useState("");
	const [order, setOrder] = useState<Order>({ by: "value", desc: false });
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [editing, setEditing] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const busy = ops.migrate.isPending || ops.create.isPending;
	const isLibrary = source === "library";
	const unit = isLibrary ? "songs tagged" : "songs";
	const field = VALUE_FIELDS.find((f) => f.id === source);

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
		const hits = q === "" ? items : items.filter((i) => i.value.toLowerCase().includes(q));
		return sorted(hits, order);
	}, [items, search, order]);
	const countOf = (names: string[]) =>
		items.filter((i) => names.some((n) => same(n, i.value))).reduce((sum, i) => sum + i.count, 0);
	const openValue = detail.view?.kind === "value" ? detail.view : null;

	const toggle = (value: string) =>
		setSelected((s) => {
			const next = new Set(s);
			if (!next.delete(value)) {
				next.add(value);
			}
			return next;
		});
	const allShownSelected = shown.length > 0 && shown.every((i) => selected.has(i.value));
	const toggleAll = () =>
		setSelected(allShownSelected ? new Set() : new Set(shown.map((i) => i.value)));
	const sortBy = (by: Order["by"]) =>
		setOrder((o) => (o.by === by ? { by, desc: !o.desc } : { by, desc: by === "count" }));

	const create = async (name: string) => {
		setNotice(null);
		try {
			await ops.create.mutateAsync(name);
			setNotice({ ok: true, text: `Created “${name}”.` });
		} catch (e) {
			setNotice({ ok: false, text: String(e) });
		}
	};

	// Keep the slide-over on the value it was showing, under its new name.
	const followRename = (p: Pending) => {
		if (openValue?.field !== source || !p.from.some((f) => same(f, openValue.value))) {
			return;
		}
		if (p.to === null) {
			detail.close();
		} else {
			detail.open({ kind: "value", field: source, value: p.to });
		}
	};

	const run = async (p: Pending) => {
		setPending(null);
		setNotice(null);
		try {
			const report = await ops.migrate.mutateAsync(p);
			followRename(p);
			setSelected(new Set());
			setEditing(null);
			setNotice(noticeFor(report));
		} catch (e) {
			setNotice({ ok: false, text: String(e) });
		}
	};

	const rename = (item: Item, to: string) => {
		setEditing(null);
		if (to !== item.value) {
			setPending({ from: [item.value], to });
		}
	};

	return (
		<div className="grid gap-6 md:grid-cols-[11rem_minmax(0,1fr)]">
			<DatabaseStats
				label={field?.label ?? "Values"}
				total={items.length}
				shown={shown.length}
				search={search}
				selected={selected.size}
			/>
			<FieldNav all={all} source={source} onPick={setSource} />

			<div className="min-w-0 space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-48 flex-1">
						<Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
						<Input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={`Search ${field?.label.toLowerCase() ?? "values"}`}
							aria-label="Search values"
							className="pl-8"
						/>
					</div>
					<NewValue busy={busy} existing={items} onCreate={create} />
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

				<Notices notice={notice} error={ops.migrate.error ?? ops.create.error} />

				<div className="overflow-hidden rounded-lg border">
					<div className="grid h-8 grid-cols-[1.75rem_minmax(0,1fr)_6rem_4rem] items-center gap-2 border-b bg-muted/30 px-3 font-medium text-muted-foreground text-xs">
						<input
							type="checkbox"
							checked={allShownSelected}
							onChange={toggleAll}
							disabled={shown.length === 0}
							aria-label="Select all shown"
							className="size-3.5 accent-primary"
						/>
						<SortHeader
							label="Name"
							active={order.by === "value"}
							order={order}
							onClick={() => sortBy("value")}
						/>
						<SortHeader
							label="Songs"
							active={order.by === "count"}
							order={order}
							onClick={() => sortBy("count")}
							right
						/>
						<span />
					</div>
					{loading && <EmptyState title="Loading…" />}
					{!loading && shown.length === 0 && (
						<NoValues
							label={field?.label ?? "values"}
							isLibrary={isLibrary}
							searching={items.length > 0}
						/>
					)}
					<div className="divide-y">
						{shown.map((item) => (
							<Row
								key={item.value}
								item={item}
								unit={unit}
								checked={selected.has(item.value)}
								open={openValue?.field === source && same(openValue.value, item.value)}
								editing={editing === item.value}
								busy={busy}
								onOpen={() => detail.open({ kind: "value", field: source, value: item.value })}
								onToggle={() => toggle(item.value)}
								onEdit={() => setEditing(item.value)}
								onCancel={() => setEditing(null)}
								onRename={(to) => rename(item, to)}
								onDelete={() => setPending({ from: [item.value], to: null })}
							/>
						))}
					</div>
				</div>
			</div>

			{pending && (
				<Confirm
					pending={pending}
					affected={countOf(pending.from)}
					items={items}
					rewritesFiles={!isLibrary}
					onCancel={() => setPending(null)}
					onConfirm={() => run(pending)}
				/>
			)}
		</div>
	);
}

function Notices({
	notice,
	error,
}: {
	notice: { ok: boolean; text: string } | null;
	error: unknown;
}) {
	return (
		<>
			{notice && (
				<p className={cn("text-sm", notice.ok ? "text-muted-foreground" : "text-destructive")}>
					{notice.text}
				</p>
			)}
			{error != null && <ErrorText message={String(error)} className="text-destructive text-sm" />}
		</>
	);
}

function noticeFor(report: FixReport | null): { ok: boolean; text: string } {
	if (!report) {
		return { ok: true, text: "Done." };
	}
	const failed = report.failed.length;
	if (failed === 0) {
		return { ok: true, text: `Updated ${plural(report.fixed, "song", "songs")}.` };
	}
	return {
		ok: false,
		text: `${report.fixed} updated, ${failed} failed: ${report.failed[0]?.error ?? ""}`,
	};
}

function FieldNav({
	all,
	source,
	onPick,
}: {
	all: Lists;
	source: ValueField;
	onPick: (f: ValueField) => void;
}) {
	return (
		<nav aria-label="Fields" className="flex flex-wrap gap-0.5 md:flex-col">
			{VALUE_FIELDS.map((f) => (
				<button
					key={f.id}
					type="button"
					onClick={() => onPick(f.id)}
					aria-current={source === f.id ? "true" : undefined}
					className={cn(
						"flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
						source === f.id
							? "bg-muted font-medium text-foreground"
							: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
						f.id === "library" && "md:mt-3",
					)}
				>
					<span className="truncate">{f.label}</span>
					<span className="text-muted-foreground text-xs tabular-nums">
						{all[f.id].loading ? "" : all[f.id].items.length}
					</span>
				</button>
			))}
		</nav>
	);
}

function NoValues({
	label,
	isLibrary,
	searching,
}: {
	label: string;
	isLibrary: boolean;
	searching: boolean;
}) {
	if (searching) {
		return (
			<EmptyState title="No match">Try a shorter search, or create it as a new value.</EmptyState>
		);
	}
	return (
		<EmptyState title={`No ${label.toLowerCase()} yet`}>
			{isLibrary
				? "Tag songs from their right-click menu, or create a tag here."
				: "Values appear here once a song has them. Create one to offer it in the tag editor."}
		</EmptyState>
	);
}

/** Status bar figures for the tag database view. */
function DatabaseStats({
	label,
	total,
	shown,
	search,
	selected,
}: {
	label: string;
	total: number;
	shown: number;
	search: string;
	selected: number;
}) {
	return (
		<StatusBar>
			<Stat label={label} value={total} />
			{search.trim() !== "" && <Stat label="Matching" value={shown} />}
			{selected > 0 && <Stat label="Selected" value={selected} />}
		</StatusBar>
	);
}

function SortHeader({
	label,
	active,
	order,
	onClick,
	right = false,
}: {
	label: string;
	active: boolean;
	order: Order;
	onClick: () => void;
	right?: boolean;
}) {
	const Arrow = order.desc ? ArrowDown : ArrowUp;
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={`Sort by ${label.toLowerCase()}`}
			className={cn(
				"flex items-center gap-1 hover:text-foreground",
				right && "justify-end",
				active && "text-foreground",
			)}
		>
			{label}
			{active && <Arrow className="size-3" />}
		</button>
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
				placeholder="New value"
				aria-label="New value"
				aria-invalid={taken || undefined}
				title={taken ? "That value already exists" : undefined}
				className="w-44"
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
		<div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2">
			<span className="px-1 font-medium text-sm tabular-nums">{selected.length} selected</span>
			<Input
				value={target}
				onChange={(e) => setTarget(e.target.value)}
				list={listId}
				placeholder="Merge into…"
				aria-label="Merge selected into"
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
				<Merge /> Merge
			</Button>
			<Button variant="destructive" onClick={() => onMigrate(null)} disabled={busy}>
				<Trash2 /> Delete
			</Button>
			<Button variant="ghost" onClick={onClear} className="ml-auto">
				Clear selection
			</Button>
		</div>
	);
}

function Row({
	item,
	unit,
	checked,
	open,
	editing,
	busy,
	onOpen,
	onToggle,
	onEdit,
	onCancel,
	onRename,
	onDelete,
}: {
	item: Item;
	unit: string;
	checked: boolean;
	/** Its songs are showing in the slide-over. */
	open: boolean;
	editing: boolean;
	busy: boolean;
	onOpen: () => void;
	onToggle: () => void;
	onEdit: () => void;
	onCancel: () => void;
	onRename: (to: string) => void;
	onDelete: () => void;
}) {
	return (
		<div
			className={cn(
				"group grid h-10 grid-cols-[1.75rem_minmax(0,1fr)_6rem_4rem] items-center gap-2 px-3 text-sm",
				checked ? "bg-primary/10" : open ? "bg-muted" : "hover:bg-muted/50",
			)}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={onToggle}
				aria-label={`Select ${item.value}`}
				className="size-3.5 accent-primary"
			/>
			{editing ? (
				<InlineInput
					initial={item.value}
					label={`Rename ${item.value}`}
					parse={(v) => (v.trim() === "" ? null : v.trim())}
					onCommit={onRename}
					onCancel={onCancel}
				/>
			) : (
				<button
					type="button"
					onClick={onOpen}
					onDoubleClick={busy ? undefined : onEdit}
					title={`Show songs with “${item.value}”. Double-click to rename.`}
					className="min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
				>
					{item.value}
				</button>
			)}
			<span
				className="text-right text-muted-foreground text-xs tabular-nums"
				title={`${item.count} ${unit}`}
			>
				{item.count === 0 ? "Unused" : item.count}
			</span>
			<div className="flex justify-end gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={`Rename ${item.value}`}
					title="Rename"
					onClick={onEdit}
					disabled={busy || editing}
				>
					<Pencil />
				</Button>
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label={`Delete ${item.value}`}
					title="Delete"
					className="hover:text-destructive"
					onClick={onDelete}
					disabled={busy}
				>
					<Trash2 />
				</Button>
			</div>
		</div>
	);
}

function Confirm({
	pending,
	affected,
	items,
	rewritesFiles,
	onCancel,
	onConfirm,
}: {
	pending: Pending;
	affected: number;
	items: Item[];
	rewritesFiles: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const merge =
		pending.to !== null &&
		items.some((i) => same(i.value, pending.to ?? "") && !pending.from.includes(i.value));
	const names = pending.from.map((n) => `“${n}”`).join(", ");
	let title: string;
	let label: string;
	if (pending.to === null) {
		title = `Delete ${names}?`;
		label = "Delete";
	} else if (merge || pending.from.length > 1) {
		title = `Merge ${names} into “${pending.to}”?`;
		label = "Merge";
	} else {
		title = `Rename ${names} to “${pending.to}”?`;
		label = "Rename";
	}
	return (
		<ConfirmDialog
			title={title}
			confirmLabel={label}
			destructive={pending.to === null}
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			{affected === 0
				? "No song uses this yet."
				: `Changes up to ${plural(affected, "song", "songs")}.`}
			{rewritesFiles && affected > 0 && " The tags inside the audio files are rewritten."}
			{pending.to === null && affected > 0 && " The value is removed from each of them."}
		</ConfirmDialog>
	);
}
