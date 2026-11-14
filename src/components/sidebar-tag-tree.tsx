import { useQuery } from "@tanstack/react-query";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { ChevronRight, Tag } from "lucide-react";
import { useMemo, useState } from "react";
import { RowCount, SectionLabel } from "#/components/sidebar-parts.tsx";
import { rowBase, rowClass } from "#/components/sidebar-row.ts";
import { listTags } from "#/lib/api.ts";
import { buildTagTree, type TagNode } from "#/lib/tag-tree.ts";
import { cn } from "#/lib/utils.ts";

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
export function SidebarTagTree() {
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const tree = useMemo(() => buildTagTree(tags.data ?? []), [tags.data]);
	const [open, setOpen] = useState(loadOpen);
	const matchRoute = useMatchRoute();

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
					<div className={rowClass(active)}>
						<Link
							to="/tags/$"
							params={{ _splat: n.name }}
							title={n.name}
							className={rowBase}
							style={{ paddingLeft: `${8 + depth * 14}px` }}
						>
							<Tag className="size-4 shrink-0" />
							<span className="truncate">{n.label}</span>
							<RowCount n={n.trackCount} />
						</Link>
						{n.children.length > 0 ? (
							<button
								type="button"
								aria-label={isOpen ? `Collapse ${n.label}` : `Expand ${n.label}`}
								aria-expanded={isOpen}
								className="grid size-5 shrink-0 place-items-center rounded hover:bg-background/60"
								onClick={() => toggle(key)}
							>
								<ChevronRight
									className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
								/>
							</button>
						) : (
							<span className="size-5 shrink-0" />
						)}
					</div>
					{isOpen && rows(n.children, depth + 1)}
				</div>
			);
		});

	if (tree.length === 0) {
		return null;
	}
	return (
		<section className="mt-4 space-y-0.5">
			<SectionLabel>Tags</SectionLabel>
			{rows(tree, 0)}
		</section>
	);
}
