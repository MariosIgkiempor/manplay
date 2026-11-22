import { useQueries, useQuery } from "@tanstack/react-query";
import {
	AudioLines,
	Building2,
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
	Shuffle,
	Smile,
	Tags,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { Framed, FrameHeader, TabsSearchBar } from "#/components/frame.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { SearchField } from "#/components/search-field.tsx";
import { SortMenu } from "#/components/sort-menu.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { TagCombobox } from "#/components/tag-combobox.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { type FixReport, listTags, tagValues } from "#/lib/api.ts";
import { PAGE_BODY, WELL_ROWS } from "#/lib/page-layout.ts";
import { useTagDatabaseOps, useTracks } from "#/lib/queries.ts";
import { type ListSort, VALUE_SORTS, type ValueSort } from "#/lib/sorting.ts";
import { trackHasValue, VALUE_FIELDS, type ValueField } from "#/lib/track-fields.ts";
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

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const byName = (a: Item, b: Item) => a.value.localeCompare(b.value);

/** One value's row, laid out like a song row, in the list's well. */
const ROW =
	"group grid min-h-12 grid-cols-[1.25rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-1.5 text-sm";

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

/** The values whose name holds `query` (already trimmed and lower-cased); all of them for none. */
function matching(items: Item[], query: string): Item[] {
	return query === "" ? items : items.filter((i) => i.value.toLowerCase().includes(query));
}

/**
 * While searching, the field to show: the one open if anything in it matches, otherwise the first
 * field that has a match, so a search finds values on every tab and not only the open one.
 */
function fieldWithMatches(all: Lists, open: ValueField, query: string): ValueField {
	if (query === "" || matching(all[open].items, query).length > 0) {
		return open;
	}
	return FIELD_IDS.find((id) => matching(all[id].items, query).length > 0) ?? open;
}

function sorted(items: Item[], sort: ListSort<ValueSort>): Item[] {
	const sign = sort.desc ? -1 : 1;
	return [...items].sort((a, b) =>
		sort.key === "songs" ? sign * (a.count - b.count) || byName(a, b) : sign * byName(a, b),
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
	const [sort, setSort] = useState<ListSort<ValueSort>>({ key: "name", desc: false });
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
		setNotice(null);
	}, [source]);

	// The search covers every field: jump to one with matches when the open one has none.
	const query = search.trim().toLowerCase();
	useEffect(() => {
		setSource((open) => fieldWithMatches(all, open, query));
	}, [all, query]);

	const shown = useMemo(() => sorted(matching(items, query), sort), [items, query, sort]);
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
	const unused = items.filter((i) => i.count === 0).length;
	return (
		<main>
			<DatabaseStats
				label={label}
				total={items.length}
				shown={shown.length}
				search={search}
				selected={selected.size}
			/>
			<FrameHeader
				title="Metadata"
				continued
				meta={
					<>
						<span>{plural(VALUE_FIELDS.length, "field", "fields")}</span>
						<span>{plural(totalValues, "value", "values")}</span>
					</>
				}
				actions={
					<Button variant="outline" disabled={busy || creating} onClick={() => setCreating(true)}>
						<Plus /> Create
					</Button>
				}
			/>
			{/* The fields, the search across all of them, and any selection stay at hand. */}
			<TabsSearchBar
				tabs={<FieldTabs all={all} query={query} source={source} onPick={setSource} />}
				search={<ValueSearch search={search} onSearch={setSearch} sort={sort} onSort={setSort} />}
				below={
					selected.size > 0 && (
						<MigrateBar
							selected={[...selected]}
							items={items}
							busy={busy}
							onClear={() => setSelected(new Set())}
							onMigrate={(to) => setPending({ from: [...selected], to })}
						/>
					)
				}
			/>

			<div className={cn("space-y-3", PAGE_BODY)}>
				<Notices notice={notice} error={ops.migrate.error ?? ops.create.error} />
				{!loading && unused > 0 && (
					<p className="text-muted-foreground text-xs">
						{plural(unused, "value is", "values are")} not used by any song.
					</p>
				)}
				{loading && <EmptyState title="Loading…" />}
				{!loading && shown.length === 0 && !creating && (
					<NoValues label={label} isLibrary={isLibrary} searching={items.length > 0} />
				)}
				<Framed className="has-[>div:empty]:hidden">
					<div className={cn(WELL_ROWS, "empty:hidden")}>
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
									selecting={selected.size > 0}
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
				</Framed>
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
		</main>
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

/** The fields as the page's header tabs, scrolling sideways when they do not all fit. */
/** One tab per field, each counting its values; while searching, the fields with matches. */
function FieldTabs({
	all,
	query,
	source,
	onPick,
}: {
	all: Lists;
	query: string;
	source: ValueField;
	onPick: (f: ValueField) => void;
}) {
	return (
		<Segmented
			className="w-max border-b-0"
			value={source}
			onChange={onPick}
			label="Fields"
			// While searching, only the fields with matches, so every hit is in view.
			items={VALUE_FIELDS.map((f) => ({
				value: f.id,
				label: f.label,
				icon: FIELD_ICONS[f.id],
				count: all[f.id].loading ? 0 : matching(all[f.id].items, query).length,
			})).filter((t) => query === "" || t.count > 0 || t.value === source)}
		/>
	);
}

/** Same search bar as the library: the field, then the sort menu at its right end. */
function ValueSearch({
	search,
	onSearch,
	sort,
	onSort,
}: {
	search: string;
	onSearch: (text: string) => void;
	sort: ListSort<ValueSort>;
	onSort: (sort: ListSort<ValueSort>) => void;
}) {
	return (
		<SearchField
			value={search}
			onChange={onSearch}
			placeholder="Search every field"
			label="Search values"
			trailing={
				<SortMenu
					options={VALUE_SORTS}
					value={sort}
					onChange={onSort}
					className="h-full px-2.5 text-sm"
				/>
			}
		/>
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
		<div className={`${ROW} bg-primary/5`}>
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
			<span className="w-36 text-right text-muted-foreground text-xs">New</span>
			<span className="w-14" />
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
	const id = useId();
	const [target, setTarget] = useState("");
	const to = target.trim();
	const options = items.filter((i) => !selected.includes(i.value));
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-1.5 pl-2">
			<span className="font-medium text-sm tabular-nums">{selected.length} selected</span>
			<Button
				size="icon-xs"
				variant="ghost"
				aria-label="Clear selection"
				title="Clear selection"
				onClick={onClear}
			>
				<X />
			</Button>
			<div className="ml-auto flex flex-wrap items-center gap-2">
				<div className="w-64">
					<TagCombobox
						id={id}
						value={target}
						options={options}
						multi={false}
						placeholder="Merge into…"
						touched={false}
						onChange={setTarget}
						className="bg-background dark:bg-background"
					/>
				</div>
				<Button onClick={() => onMigrate(to)} disabled={busy || to === ""}>
					<Merge /> Merge
				</Button>
				<Button
					variant="ghost"
					className="text-destructive hover:bg-destructive/10 hover:text-destructive"
					onClick={() => onMigrate(null)}
					disabled={busy}
				>
					<Trash2 /> Delete
				</Button>
			</div>
		</div>
	);
}

function rowTint(checked: boolean, open: boolean): string {
	// The same marks as a song row: a cue tint for chosen rows, a cue rule for the one open.
	if (checked) {
		return "bg-primary/[0.09] shadow-[inset_2px_0_0_0_var(--primary)]";
	}
	return open ? "bg-white/[0.03] shadow-[inset_2px_0_0_0_var(--primary)]" : "hover:bg-white/[0.03]";
}

function Row({
	item,
	unit,
	checked,
	selecting,
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
	/** Some value is selected, so every row shows its checkbox. */
	selecting: boolean;
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
		<div className={cn(ROW, rowTint(checked, open))}>
			<input
				type="checkbox"
				checked={checked}
				onChange={onToggle}
				aria-label={`Select ${item.value}`}
				className={cn(
					"size-3.5 accent-primary focus-visible:opacity-100 group-hover:opacity-100",
					!(checked || selecting) && "opacity-0",
				)}
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
				className="flex w-36 items-center justify-end gap-2 text-muted-foreground text-xs tabular-nums"
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
			<div className="flex w-14 justify-end gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
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
