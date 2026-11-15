import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import {
	Database,
	Download,
	FolderTree,
	Library,
	ListMusic,
	Music,
	Plus,
	Settings,
	Upload,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { RowCount, SectionLabel } from "#/components/sidebar-parts.tsx";
import { rowBase, rowClass } from "#/components/sidebar-row.ts";
import { SidebarTagTree } from "#/components/sidebar-tag-tree.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { createPlaylist, listPlaylists } from "#/lib/api.ts";
import { useUpdateCheck } from "#/lib/updater.ts";

const linkClass =
	"flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground";
const activeProps = { className: "bg-muted font-medium text-foreground" } as const;

function NavLink({
	children,
	...props
}: {
	to: "/" | "/files" | "/import" | "/export" | "/metadata" | "/settings";
	children: ReactNode;
}) {
	return (
		<Link
			{...props}
			className={linkClass}
			activeOptions={{ exact: true }}
			activeProps={activeProps}
		>
			{children}
		</Link>
	);
}

export function Sidebar() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const syncing = useSyncProgress().size > 0;
	const updateAvailable = useUpdateCheck().data != null;
	const [name, setName] = useState("");
	const matchRoute = useMatchRoute();
	const activePlaylist = (() => {
		const m = matchRoute({ to: "/playlists/$id" });
		return m ? Number(m.id) : null;
	})();
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const create = useMutation({
		mutationFn: createPlaylist,
		onSuccess: async (id) => {
			setName("");
			await queryClient.invalidateQueries({ queryKey: ["playlists"] });
			await navigate({ to: "/playlists/$id", params: { id: String(id) } });
		},
	});

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (trimmed !== "") {
			create.mutate(trimmed);
		}
	};

	return (
		<aside className="flex w-60 shrink-0 flex-col gap-4 border-r bg-card/40 p-3">
			<div className="flex items-center gap-2 px-2 pt-1 font-semibold">
				<Music className="size-5 text-primary" />
				manplay
			</div>
			<nav className="space-y-0.5">
				<NavLink to="/">
					<Library className="size-4" />
					Library
				</NavLink>
				<NavLink to="/files">
					<FolderTree className="size-4" />
					Files
				</NavLink>
				<NavLink to="/metadata">
					<Database className="size-4" />
					Metadata
				</NavLink>
				<NavLink to="/import">
					<Download className="size-4" />
					Import
				</NavLink>
				<NavLink to="/export">
					<Upload className="size-4" />
					Export
					{syncing && <span className="ml-auto size-2 animate-pulse rounded-full bg-primary" />}
				</NavLink>
			</nav>
			<div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
				<section className="space-y-0.5">
					<SectionLabel>Playlists</SectionLabel>
					{playlists.data?.map((p) => (
						<div key={p.id} className={rowClass(activePlaylist === p.id)}>
							<Link to="/playlists/$id" params={{ id: String(p.id) }} className={rowBase}>
								<ListMusic className="size-4 shrink-0" />
								<span className="truncate">{p.name}</span>
								<RowCount n={p.trackCount} />
							</Link>
							<span className="size-5 shrink-0" />
						</div>
					))}
				</section>
				<SidebarTagTree />
			</div>
			<form onSubmit={onSubmit} className="flex gap-2">
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New playlist" />
				<Button
					type="submit"
					size="icon"
					variant="outline"
					aria-label="Create playlist"
					disabled={create.isPending || name.trim() === ""}
				>
					<Plus />
				</Button>
			</form>
			{create.isError && <p className="text-destructive text-xs">{String(create.error)}</p>}
			<nav className="border-t pt-2">
				<NavLink to="/settings">
					<Settings className="size-4" />
					Settings
					{updateAvailable && (
						<span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
							Update
						</span>
					)}
				</NavLink>
			</nav>
		</aside>
	);
}
