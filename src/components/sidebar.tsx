import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { createPlaylist, listPlaylists } from "#/lib/api.ts";

const linkClass = "block truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted";
const activeClass = { className: "bg-muted font-medium" } as const;

export function Sidebar() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
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
		<aside className="flex w-56 shrink-0 flex-col gap-3 border-r p-3">
			<Link to="/" className={linkClass} activeOptions={{ exact: true }} activeProps={activeClass}>
				Library
			</Link>
			<div className="font-medium text-muted-foreground text-xs uppercase">Playlists</div>
			<nav className="flex-1 space-y-0.5 overflow-y-auto">
				{playlists.data?.map((p) => (
					<Link
						key={p.id}
						to="/playlists/$id"
						params={{ id: String(p.id) }}
						className={linkClass}
						activeProps={activeClass}
					>
						{p.name} <span className="text-muted-foreground">({p.trackCount})</span>
					</Link>
				))}
			</nav>
			<form onSubmit={onSubmit} className="flex gap-2">
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New playlist" />
				<Button type="submit" disabled={create.isPending}>
					+
				</Button>
			</form>
			{create.isError && <p className="text-destructive text-xs">{String(create.error)}</p>}
		</aside>
	);
}
