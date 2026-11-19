import { ChevronRight, Tag as TagIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { SearchField } from "#/components/search-field.tsx";
import type { Tag } from "#/lib/api.ts";
import { setTagTree, type TagCheck, tagCheck } from "#/lib/rekordbox-selection.ts";
import { buildTagTree, type TagNode } from "#/lib/tag-tree.ts";
import { cn } from "#/lib/utils.ts";

/** The scrolling box a list of check rows sits in. */
export function CheckList({ children }: { children: ReactNode }) {
	return (
		<div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border bg-background p-1">
			{children}
		</div>
	);
}

const tracks = (n: number) => `${n.toLocaleString()} ${n === 1 ? "track" : "tracks"}`;

/** One checkable playlist or tag; "some" shows the box half-checked. */
export function CheckRow({
	state,
	onChange,
	label,
	detail,
	note,
	indent = 0,
	lead,
	icon,
}: {
	state: TagCheck;
	onChange: (on: boolean) => void;
	label: string;
	detail: string;
	/** A second, quieter line under the label. */
	note?: string | undefined;
	indent?: number;
	lead?: ReactNode;
	icon: ReactNode;
}) {
	const box = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (box.current) {
			box.current.indeterminate = state === "some";
		}
	}, [state]);
	return (
		<div
			className={cn(
				"flex items-center gap-1 rounded-lg pr-2 transition-colors hover:bg-muted/60",
				state === "on" && "bg-primary/5",
			)}
			style={{ paddingLeft: `${4 + indent * 16}px` }}
		>
			<span className="flex size-6 shrink-0 items-center justify-center">{lead}</span>
			<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-sm">
				<input
					ref={box}
					type="checkbox"
					checked={state === "on"}
					onChange={(e) => onChange(e.target.checked)}
					className="size-4 accent-primary"
				/>
				<span className="shrink-0 text-muted-foreground">{icon}</span>
				<span className="min-w-0 flex-1">
					<span className={cn("block truncate", state === "off" && "text-muted-foreground")}>
						{label}
					</span>
					{note && <span className="block truncate text-muted-foreground text-xs">{note}</span>}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">{detail}</span>
			</label>
		</div>
	);
}

export function LinkButton({
	children,
	onClick,
	disabled,
}: {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="rounded text-muted-foreground hover:text-foreground focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-40"
		>
			{children}
		</button>
	);
}

export function Filter({
	value,
	onChange,
	label,
}: {
	value: string;
	onChange: (v: string) => void;
	label: string;
}) {
	return <SearchField value={value} onChange={onChange} placeholder={label} />;
}

function TagRows({
	nodes,
	depth,
	selected,
	open,
	toggleOpen,
	onChange,
	flat,
	noteFor,
}: {
	nodes: TagNode[];
	depth: number;
	selected: readonly string[];
	open: ReadonlySet<string>;
	toggleOpen: (key: string) => void;
	onChange: (node: TagNode, on: boolean) => void;
	flat: boolean;
	noteFor?: ((node: TagNode) => string | undefined) | undefined;
}) {
	return nodes.map((n) => {
		const key = n.name.toLowerCase();
		const hasKids = n.children.length > 0 && !flat;
		return (
			<div key={key}>
				<CheckRow
					indent={flat ? 0 : depth}
					label={flat ? n.name : n.label}
					detail={tracks(n.trackCount)}
					note={noteFor?.(n)}
					icon={<TagIcon className="size-4" />}
					state={tagCheck(selected, n)}
					onChange={(on) => onChange(n, on)}
					lead={
						hasKids && (
							<button
								type="button"
								aria-label={`${open.has(key) ? "Collapse" : "Expand"} ${n.label}`}
								aria-expanded={open.has(key)}
								onClick={() => toggleOpen(key)}
								className="rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								<ChevronRight
									className={cn("size-4 transition-transform", open.has(key) && "rotate-90")}
								/>
							</button>
						)
					}
				/>
				{hasKids && open.has(key) && (
					<TagRows
						nodes={n.children}
						depth={depth + 1}
						selected={selected}
						open={open}
						toggleOpen={toggleOpen}
						onChange={onChange}
						flat={flat}
						noteFor={noteFor}
					/>
				)}
			</div>
		);
	});
}

/**
 * The library's tags as a collapsible tree of checkboxes. Checking a tag checks everything below
 * it; a filter appears once there are enough tags to need one.
 */
export function TagTree({
	tags,
	selected,
	onChange,
	noteFor,
}: {
	tags: readonly Tag[];
	selected: readonly string[];
	onChange: (names: string[]) => void;
	noteFor?: (node: TagNode) => string | undefined;
}) {
	const [filter, setFilter] = useState("");
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const tree = useMemo(() => buildTagTree(tags), [tags]);
	const needle = filter.trim().toLowerCase();
	// While filtering, matching tags show as a flat list so a deep match is never hidden.
	const matches = useMemo(
		() =>
			needle
				? tree
						.flatMap(function walk(n): TagNode[] {
							return [n, ...n.children.flatMap(walk)];
						})
						.filter((n) => n.name.toLowerCase().includes(needle))
				: [],
		[tree, needle],
	);
	const toggleOpen = (key: string) =>
		setOpen((s) => {
			const next = new Set(s);
			if (!next.delete(key)) {
				next.add(key);
			}
			return next;
		});
	return (
		<>
			{tags.length > 8 && <Filter value={filter} onChange={setFilter} label="Filter tags" />}
			<CheckList>
				<TagRows
					nodes={needle ? matches : tree}
					depth={0}
					selected={selected}
					open={open}
					toggleOpen={toggleOpen}
					onChange={(node, on) => onChange(setTagTree(selected, node, on))}
					flat={needle !== ""}
					noteFor={noteFor}
				/>
				{needle && matches.length === 0 && (
					<p className="px-3 py-2 text-muted-foreground text-sm">No tag matches.</p>
				)}
			</CheckList>
		</>
	);
}
