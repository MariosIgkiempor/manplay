import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Tag } from "lucide-react";
import { useMemo, useState } from "react";
import { useDetail } from "#/context/detail-context.ts";
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

/** Library tags as a collapsible tree; clicking one opens its songs (and those below it). */
export function SidebarTagTree() {
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const tree = useMemo(() => buildTagTree(tags.data ?? []), [tags.data]);
	const [open, setOpen] = useState(loadOpen);
	const detail = useDetail();
	const active = detail.view?.kind === "tag" ? detail.view.name.toLowerCase() : null;

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
			return (
				<div key={key}>
					<div
						className={cn(
							"group flex items-center gap-1 rounded-md py-1 pr-2 text-muted-foreground text-sm hover:bg-muted hover:text-foreground",
							active === key && "bg-muted font-medium text-foreground",
						)}
						style={{ paddingLeft: `${depth * 12 + 4}px` }}
					>
						{n.children.length > 0 ? (
							<button
								type="button"
								aria-label={isOpen ? `Collapse ${n.label}` : `Expand ${n.label}`}
								className="rounded p-0.5 hover:bg-background/60"
								onClick={() => toggle(key)}
							>
								<ChevronRight
									className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
								/>
							</button>
						) : (
							<span className="w-[18px] shrink-0" />
						)}
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-2 text-left"
							title={n.name}
							onClick={() => detail.open({ kind: "tag", name: n.name })}
						>
							<Tag className="size-3.5 shrink-0" />
							<span className="truncate">{n.label}</span>
							<span className="ml-auto text-xs">{n.trackCount}</span>
						</button>
					</div>
					{isOpen && rows(n.children, depth + 1)}
				</div>
			);
		});

	if (tree.length === 0) {
		return null;
	}
	return (
		<>
			<div className="px-2 pt-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				Tags
			</div>
			<div className="space-y-0.5">{rows(tree, 0)}</div>
		</>
	);
}
