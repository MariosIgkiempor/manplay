import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CloudUpload, Library, ListMusic, Music, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { createPlaylist, listPlaylists } from "#/lib/api.ts";

const linkClass =
	"flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground";
const activeProps = { className: "bg-muted font-medium text-foreground" } as const;

function NavLink({ children, ...props }: { to: "/" | "/sync"; children: ReactNode }) {
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
	const [name, setName] = useState("");
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
				<NavLink to="/sync">
					<CloudUpload className="size-4" />
					Sync
					{syncing && <span className="ml-auto size-2 animate-pulse rounded-full bg-primary" />}
				</NavLink>
			</nav>
			<div className="px-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				Playlists
			</div>
			<nav className="-mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
				{playlists.data?.map((p) => (
					<Link
						key={p.id}
						to="/playlists/$id"
						params={{ id: String(p.id) }}
						className={linkClass}
						activeProps={activeProps}
					>
						<ListMusic className="size-4 shrink-0" />
						<span className="truncate">{p.name}</span>
						<span className="ml-auto text-xs">{p.trackCount}</span>
					</Link>
				))}
			</nav>
			<form onSubmit={onSubmit} className="flex gap-2">
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New playlist" />
				<Button type="submit" size="icon" aria-label="Create playlist" disabled={create.isPending}>
					<Plus />
				</Button>
			</form>
			{create.isError && <p className="text-destructive text-xs">{String(create.error)}</p>}
		</aside>
	);
}
