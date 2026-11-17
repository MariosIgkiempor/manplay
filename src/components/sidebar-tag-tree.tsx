import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRight, PencilLine, Play, Tag, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { HiddenItems, ScopeMark } from "#/components/item-sharing.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { AddButton, NewRow } from "#/components/sidebar-create.tsx";
import { GroupHeading, RowCount } from "#/components/sidebar-parts.tsx";
import { CHILD_PAD, HOVER_ACTION, rowBase, rowClass } from "#/components/sidebar-row.ts";
import { usePlayer } from "#/context/player-context.ts";
import {
	createTag as createLibraryTag,
	listTags,
	migrateLibraryTags,
	type Tag as TagItem,
} from "#/lib/api.ts";
import { useTracks } from "#/lib/queries.ts";
import { buildTagTree, TAG_SEP, type TagNode, tagWithin, trackHasTag } from "#/lib/tag-tree.ts";
import { useItemSharing, useNewItemScope } from "#/lib/use-item-sharing.tsx";
import { useStoredFlag } from "#/lib/use-pane-width.ts";
import { cn } from "#/lib/utils.ts";

/** A rename or delete waiting for a yes: `to` is the new full name, `null` deletes. */
type Ask = { from: string; to: string | null; count: number };

/** Merging a local tag into a shared one shows its songs to everyone. */
function sharesPrivate(tags: readonly TagItem[], from: string, to: string): boolean {
	const find = (name: string) => tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
	return find(from)?.scope === "local" && (find(to)?.scope ?? "shared") === "shared";
}

/** What a rename or delete in the sidebar tells the user before it runs. */
function askBody(ask: Ask, tags: readonly TagItem[]): string {
	if (ask.to === null) {
		return `${ask.count} ${ask.count === 1 ? "song loses" : "songs lose"} it, subtags too. The songs stay in your library.`;
	}
	const note = sharesPrivate(tags, ask.from, ask.to)
		? ` “${ask.from}” is only on this device: its ${ask.count} ${ask.count === 1 ? "song becomes" : "songs become"} visible to everyone on the destination.`
		: "";
	return `“${ask.to}” already exists, so its songs and these become one tag.${note}`;
}

const nonBlank = (v: string) => {
	const t = v.trim();
	return t === "" || t.includes(TAG_SEP) ? null : t;
};

/** Rename, merge and delete library tags from the sidebar, following the open tag page along. */
function useTagMove() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	return useMutation({
		mutationFn: ({ from, to }: { from: string; to: string | null }) =>
			migrateLibraryTags([from], to),
		onSuccess: async (_, { from, to }) => {
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] });
			const open = matchRoute({ to: "/tags/$", fuzzy: true });
			const current = open ? (open._splat ?? "") : null;
			if (current !== null && tagWithin(current, from)) {
				await (to === null
					? navigate({ to: "/" })
					: navigate({
							to: "/tags/$",
							params: { _splat: to + current.slice(from.length) },
							replace: true,
						}));
			}
		},
	});
}

const OPEN_KEY = "manplay.sidebar.openTags";

function loadOpen(): Set<string> {
	try {
		const raw = localStorage.getItem(OPEN_KEY);
		return new Set(raw ? (JSON.parse(raw) as string[]) : []);
	} catch {
		return new Set();
	}
}

function saveOpen(open: ReadonlySet<string>) {
	try {
		localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
	} catch {
		// Remembering expanded tags is only a convenience.
	}
}

/** Library tags as a collapsible tree; clicking one opens its page. */
/** Opens or closes a tag's subtags; an empty slot for tags without any, so rows line up. */
function ExpandButton({
	node,
	open,
	onToggle,
}: {
	node: TagNode;
	open: boolean;
	onToggle: () => void;
}) {
	if (node.children.length === 0) {
		return <span className="size-5 shrink-0" />;
	}
	return (
		<button
			type="button"
			aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
			aria-expanded={open}
			className="grid size-5 shrink-0 place-items-center rounded hover:bg-background/60"
			onClick={onToggle}
		>
			<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
		</button>
	);
}

export function SidebarTagTree() {
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const sharing = useItemSharing();
	const hiddenTags = useMemo(() => (tags.data ?? []).filter((t) => t.hidden), [tags.data]);
	const tree = useMemo(() => buildTagTree((tags.data ?? []).filter((t) => !t.hidden)), [tags.data]);
	const [open, setOpen] = useState(loadOpen);
	const matchRoute = useMatchRoute();
	const player = usePlayer();
	const tracks = useTracks();
	const move = useTagMove();
	const [renaming, setRenaming] = useState<string | null>(null);
	const [ask, setAsk] = useState<Ask | null>(null);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	/** Creates an empty tag (inside `parent` when given), opens it, and shows it in the tree. */
	const newScope = useNewItemScope();
	const createTag = async (leaf: string, parent?: TagNode) => {
		const name = parent ? `${parent.name}${TAG_SEP}${leaf}` : leaf;
		await createLibraryTag(name, newScope.value);
		await queryClient.invalidateQueries({ queryKey: ["tags"] });
		await navigate({ to: "/tags/$", params: { _splat: name } });
	};
	/** Where a new tag is being named: "" at the top level, else its parent's key. */
	const [adding, setAdding] = useState<string | null>(null);
	const [closed, setClosed] = useStoredFlag("manplay.sidebar.tagsClosed");
	const startTag = (parent: TagNode) => {
		const key = parent.name.toLowerCase();
		if (!open.has(key)) {
			toggle(key);
		}
		setAdding(key);
	};
	const newTagRow = (parent: TagNode | undefined, depth: number) => (
		<NewRow
			icon={<Tag />}
			indent={CHILD_PAD + depth * 14}
			placeholder={parent ? `New tag in ${parent.label}` : "Tag name"}
			parse={nonBlank}
			onCancel={() => {
				setAdding(null);
				newScope.reset();
			}}
			onCreate={(leaf) => createTag(leaf, parent)}
			scope={newScope.prop}
		/>
	);
	const songsWith = (name: string) => (tracks.data ?? []).filter((t) => trackHasTag(t, name));
	const rename = (n: TagNode, leaf: string) => {
		setRenaming(null);
		const cut = n.name.lastIndexOf(TAG_SEP);
		const to = cut < 0 ? leaf : `${n.name.slice(0, cut + 1)}${leaf}`;
		const taken = (tags.data ?? []).some(
			(t) =>
				t.name.toLowerCase() === to.toLowerCase() && t.name.toLowerCase() !== n.name.toLowerCase(),
		);
		if (taken) {
			setAsk({ from: n.name, to, count: n.trackCount });
		} else if (to !== n.name) {
			move.mutate({ from: n.name, to });
		}
	};

	const toggle = (key: string) =>
		setOpen((s) => {
			const next = new Set(s);
			if (!next.delete(key)) {
				next.add(key);
			}
			saveOpen(next);
			return next;
		});

	const rows = (nodes: TagNode[], depth: number) =>
		nodes.map((n) => {
			const key = n.name.toLowerCase();
			const isOpen = open.has(key);
			const active = !!matchRoute({ to: "/tags/$", params: { _splat: n.name } });
			return (
				<div key={key}>
					<RowMenu
						label={n.name}
						items={[
							{
								label: "Play",
								icon: <Play />,
								disabled: n.trackCount === 0,
								onSelect: () => player.play(songsWith(n.name), 0),
							},
							"separator",
							{ label: "Rename", icon: <PencilLine />, onSelect: () => setRenaming(key) },
							...(n.id === null
								? []
								: sharing.entries({ kind: "tag", id: n.id, name: n.name, scope: n.scope })),
							"separator",
							{
								label: "Delete…",
								icon: <Trash2 />,
								destructive: true,
								onSelect: () => setAsk({ from: n.name, to: null, count: n.trackCount }),
							},
						]}
					>
						<div className={cn("group/row relative", rowClass(active))}>
							{renaming === key ? (
								<div
									className="flex min-w-0 flex-1 items-center gap-2 py-0.5"
									style={{ paddingLeft: `${CHILD_PAD + depth * 14}px` }}
								>
									<Tag className="size-4 shrink-0 text-muted-foreground" />
									<InlineInput
										initial={n.label}
										label={`Rename ${n.name}`}
										parse={nonBlank}
										onCancel={() => setRenaming(null)}
										onCommit={(leaf) => rename(n, leaf)}
									/>
								</div>
							) : (
								<Link
									to="/tags/$"
									params={{ _splat: n.name }}
									title={n.name}
									className={rowBase}
									style={{ paddingLeft: `${CHILD_PAD + depth * 14}px` }}
								>
									<Tag className="size-4 shrink-0" />
									<span className="truncate">{n.label}</span>
									<ScopeMark scope={n.scope} held={n.held} />
									{/* On hover the count gives way to + (new subtag), so every row's count lines up. */}
									<RowCount
										n={n.trackCount}
										className="group-focus-within/row:invisible group-hover/row:invisible"
									/>
								</Link>
							)}
							<AddButton
								label={`New tag in ${n.label}`}
								onClick={() => startTag(n)}
								className="absolute top-1/2 right-6 -translate-y-1/2 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
							/>
							<ExpandButton node={n} open={isOpen} onToggle={() => toggle(key)} />
						</div>
					</RowMenu>
					{adding === key && newTagRow(n, depth + 1)}
					{isOpen && rows(n.children, depth + 1)}
				</div>
			);
		});

	return (
		<div className="space-y-0.5">
			<GroupHeading
				label="Tags"
				icon={<Tag />}
				open={!closed}
				onToggle={() => setClosed(!closed)}
				action={
					<AddButton
						label="New tag"
						className={HOVER_ACTION}
						onClick={() => {
							setClosed(false);
							setAdding("");
						}}
					/>
				}
			/>
			{!closed && adding === "" && newTagRow(undefined, 0)}
			{!closed && rows(tree, 0)}
			{!closed && (
				<HiddenItems
					items={hiddenTags.map((t) => ({
						key: String(t.id),
						name: t.name,
						item: { kind: "tag", id: t.id, name: t.name, scope: t.scope ?? "shared" },
					}))}
					onUnhide={sharing.unhide}
				/>
			)}
			{sharing.dialogs}
			{move.isError && <ErrorLine className="px-2">{String(move.error)}</ErrorLine>}
			{ask && (
				<ConfirmDialog
					title={
						ask.to === null ? `Delete tag “${ask.from}”?` : `Merge “${ask.from}” into “${ask.to}”?`
					}
					confirmLabel={ask.to === null ? "Delete tag" : "Merge"}
					destructive={ask.to === null}
					busy={move.isPending}
					onCancel={() => setAsk(null)}
					onConfirm={() => {
						move.mutate({ from: ask.from, to: ask.to });
						setAsk(null);
					}}
				>
					{askBody(ask, tags.data ?? [])}
				</ConfirmDialog>
			)}
		</div>
	);
}
