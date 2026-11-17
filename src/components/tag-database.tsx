import { useQueries, useQuery } from "@tanstack/react-query";
import {
	ArrowDown,
	ArrowUp,
	AudioLines,
	Building2,
	Database,
	Disc3,
	Languages,
	Layers,
	ListMusic,
	Merge,
	Mic2,
	Pencil,
	PenLine,
	Play,
	Plus,
	Search,
	Shuffle,
	Smile,
	Tags,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { EmptyState, ErrorLine, Page } from "#/components/page.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { type FixReport, listTags, tagValues } from "#/lib/api.ts";
import { useTagDatabaseOps, useTracks } from "#/lib/queries.ts";
import { trackHasValue, VALUE_FIELDS, type ValueField } from "#/lib/track-fields.ts";
import { typeScale } from "#/lib/type-scale.ts";
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

const FIELD_IDS = VALUE_FIELDS.map((f) => f.id);
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
	const player = usePlayer();
	const tracks = useTracks();
	const all = useAllItems();
	const [source, setSource] = useState<ValueField>("artist");
	const { items, loading } = all[source];
	const ops = useTagDatabaseOps(source);
	const [search, setSearch] = useState("");
	const [order, setOrder] = useState<Order>({ by: "value", desc: false });
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [editing, setEditing] = useState<string | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
	const [creating, setCreating] = useState(false);
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	const busy = ops.migrate.isPending || ops.create.isPending;
	const isLibrary = source === "library";
	const unit = isLibrary ? "songs tagged" : "songs";
	const label = VALUE_FIELDS.find((f) => f.id === source)?.label ?? "Values";
	const songsWith = (value: string) =>
		(tracks.data ?? []).filter((t) => trackHasValue(t, source, value));

	// A different list starts clean.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the source changes
	useEffect(() => {
		setSelected(new Set());
		setEditing(null);
		setPending(null);
		setCreating(false);
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
	const maxCount = useMemo(() => Math.max(1, ...items.map((i) => i.count)), [items]);

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
			setCreating(false);
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

	const totalValues = FIELD_IDS.reduce((sum, id) => sum + all[id].items.length, 0);
	return (
		<Page
			title="Metadata"
			icon={<Database />}
			meta={
				<>
					<span>{plural(VALUE_FIELDS.length, "field", "fields")}</span>
					<span>{plural(totalValues, "value", "values")}</span>
				</>
			}
		>
			<div className="grid gap-8 md:grid-cols-[12rem_minmax(0,1fr)]">
				<DatabaseStats
					label={label}
					total={items.length}
					shown={shown.length}
					search={search}
					selected={selected.size}
				/>
				<FieldNav all={all} source={source} onPick={setSource} />

				<div className="min-w-0 space-y-4">
					<FieldHeading label={label} items={items} loading={loading} isLibrary={isLibrary} />
					<Notices notice={notice} error={ops.migrate.error ?? ops.create.error} />

					<div className="overflow-clip rounded-lg border bg-card">
						<div className="sticky top-0 z-10 bg-card">
							<div className="flex flex-wrap items-center gap-2 border-b p-3">
								<div className="relative min-w-48 flex-1">
									<Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
									<Input
										value={search}
										onChange={(e) => setSearch(e.target.value)}
										placeholder={`Search ${label.toLowerCase()}`}
										aria-label="Search values"
										className="pl-8"
									/>
								</div>
								<Button
									variant="outline"
									disabled={busy || creating}
									onClick={() => setCreating(true)}
								>
									<Plus /> Create
								</Button>
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

							<div className="grid h-9 grid-cols-[1.75rem_minmax(0,1fr)_9rem_4rem] items-center gap-2 border-b bg-card px-3 font-medium text-muted-foreground text-xs">
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
						</div>
						{loading && <EmptyState title="Loading…" />}
						{!loading && shown.length === 0 && (
							<NoValues label={label} isLibrary={isLibrary} searching={items.length > 0} />
						)}
						<div className="divide-y">
							{creating && (
								<NewValueRow
									existing={items}
									label={label}
									onCreate={create}
									onCancel={() => setCreating(false)}
								/>
							)}
							{shown.map((item) => (
								<RowMenu
									key={item.value}
									label={item.value}
									items={[
										{
											label: "Show songs",
											icon: <ListMusic />,
											onSelect: () =>
												detail.open({ kind: "value", field: source, value: item.value }),
										},
										{
											label: "Play",
											icon: <Play />,
											disabled: item.count === 0,
											onSelect: () => player.play(songsWith(item.value), 0),
										},
										"separator",
										{
											label: "Rename",
											icon: <Pencil />,
											disabled: busy,
											onSelect: () => setEditing(item.value),
										},
										{
											label: "Delete…",
											icon: <Trash2 />,
											destructive: true,
											disabled: busy,
											onSelect: () => setPending({ from: [item.value], to: null }),
										},
									]}
								>
									<Row
										item={item}
										unit={unit}
										checked={selected.has(item.value)}
										max={maxCount}
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
								</RowMenu>
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
		</Page>
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
			{error != null && <ErrorLine>{String(error)}</ErrorLine>}
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
	const groups = [
		{ title: "In the audio files", fields: VALUE_FIELDS.filter((f) => f.id !== "library") },
		{ title: "In manplay", fields: VALUE_FIELDS.filter((f) => f.id === "library") },
	];
	return (
		<nav
			aria-label="Fields"
			className="flex flex-wrap gap-x-4 gap-y-3 md:sticky md:top-6 md:flex-col md:flex-nowrap md:gap-y-4 md:self-start"
		>
			{groups.map((g) => (
				<div key={g.title} className="space-y-0.5">
					<h2 className={cn(typeScale.label, "px-2.5 pb-1")}>{g.title}</h2>
					<div className="flex flex-wrap gap-0.5 md:flex-col">
						{g.fields.map((f) => (
							<FieldButton
								key={f.id}
								icon={FIELD_ICONS[f.id]}
								label={f.label}
								count={all[f.id].loading ? null : all[f.id].items.length}
								active={source === f.id}
								onClick={() => onPick(f.id)}
							/>
						))}
					</div>
				</div>
			))}
		</nav>
	);
}

const FIELD_ICONS: Record<ValueField, ReactNode> = {
	artist: <Mic2 />,
	albumArtist: <Disc3 />,
	genre: <AudioLines />,
	label: <Building2 />,
	grouping: <Layers />,
	composer: <PenLine />,
	remixer: <Shuffle />,
	mood: <Smile />,
	language: <Languages />,
	library: <Tags />,
};

function FieldButton({
	icon,
	label,
	count,
	active,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	count: number | null;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "true" : undefined}
			className={cn(
				"relative flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
				active
					? "bg-muted font-medium text-foreground"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
			)}
		>
			{active && (
				<span
					aria-hidden="true"
					className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary"
				/>
			)}
			<span className="flex min-w-0 items-center gap-2">
				<span aria-hidden="true" className={cn("[&_svg]:size-4", active && "text-primary")}>
					{icon}
				</span>
				<span className="truncate">{label}</span>
			</span>
			<span className="text-muted-foreground text-xs tabular-nums">{count ?? ""}</span>
		</button>
	);
}

/** What the list is, how much is in it, and what changing a value does. */
function FieldHeading({
	label,
	items,
	loading,
	isLibrary,
}: {
	label: string;
	items: Item[];
	loading: boolean;
	isLibrary: boolean;
}) {
	const unused = items.filter((i) => i.count === 0).length;
	return (
		<header className="space-y-1">
			<h2 className={typeScale.panelTitle}>{label}</h2>
			<div className="flex flex-wrap gap-x-4 text-muted-foreground text-xs tabular-nums">
				{!loading && <span>{plural(items.length, "value", "values")}</span>}
				{unused > 0 && <span>{unused} unused</span>}
			</div>
			<p className={typeScale.description}>
				{isLibrary
					? "Tags you make in manplay. Audio files are not changed."
					: "Renaming or merging rewrites the tag inside every audio file that uses it."}
			</p>
		</header>
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
		return <EmptyState title="No match" />;
	}
	return (
		<EmptyState title={`No ${label.toLowerCase()} yet`}>
			{isLibrary ? "Tag songs from their right-click menu." : "Values appear once a song has them."}
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

/** A temporary row at the top of the list, named in place: Enter creates it, Escape drops it. */
function NewValueRow({
	existing,
	label,
	onCreate,
	onCancel,
}: {
	existing: Item[];
	label: string;
	onCreate: (name: string) => void;
	onCancel: () => void;
}) {
	return (
		<div className="grid h-12 grid-cols-[1.75rem_minmax(0,1fr)_9rem_4rem] items-center gap-2 bg-primary/5 px-3 text-sm">
			<Plus className="size-3.5 text-primary" aria-hidden="true" />
			<InlineInput
				initial=""
				label={`New ${label.toLowerCase()} value`}
				parse={(v) => {
					const name = v.trim();
					return existing.some((i) => same(i.value, name)) ? null : name;
				}}
				onCommit={onCreate}
				onCancel={onCancel}
			/>
			<span className="text-right text-muted-foreground text-xs">New</span>
			<span />
		</div>
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
		<div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-3 py-2">
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
	max,
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
	/** The most songs any value in this list has, so bars share one scale. */
	max: number;
	/** Its songs are showing in the side panel. */
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
				"group grid h-12 grid-cols-[1.75rem_minmax(0,1fr)_9rem_4rem] items-center gap-2 px-3 text-sm",
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
					className={cn(
						"min-w-0 truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60",
						item.count === 0 && "font-normal text-muted-foreground",
					)}
				>
					{item.value}
				</button>
			)}
			<span
				className="flex items-center justify-end gap-2 text-muted-foreground text-xs tabular-nums"
				title={`${item.count} ${unit}`}
			>
				{item.count > 0 && (
					<span aria-hidden="true" className="h-1 w-16 overflow-hidden rounded-full bg-muted">
						<span
							className="block h-full rounded-full bg-primary/60"
							style={{ width: `${Math.max(6, (item.count / max) * 100)}%` }}
						/>
					</span>
				)}
				<span className={cn("min-w-9 text-right", item.count === 0 && "italic")}>
					{item.count === 0 ? "Unused" : item.count}
				</span>
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
