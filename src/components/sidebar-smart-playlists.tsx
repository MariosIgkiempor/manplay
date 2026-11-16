import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { AddButton } from "#/components/sidebar-create.tsx";
import { GroupHeading } from "#/components/sidebar-parts.tsx";
import { CHILD_PAD, HOVER_ACTION, rowBase, rowClass } from "#/components/sidebar-row.ts";
import { deleteSmartPlaylist, type SmartPlaylist } from "#/lib/api.ts";
import { useStoredFlag } from "#/lib/use-pane-width.ts";
import { SMART_KEY, useCreateSmartPlaylist, useSmartPlaylists } from "#/lib/use-smart.ts";

/** Smart playlists in the sidebar: rules kept in the library, songs worked out live. */
export function SidebarSmartPlaylists() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const list = useSmartPlaylists();
	const create = useCreateSmartPlaylist();
	const [deleting, setDeleting] = useState<SmartPlaylist | null>(null);
	const [closed, setClosed] = useStoredFlag("manplay.sidebar.smartClosed");
	const m = matchRoute({ to: "/smart/$id" });
	const active = m ? Number(m.id) : null;
	const remove = useMutation({
		mutationFn: (id: number) => deleteSmartPlaylist(id),
		onSuccess: async (_, id) => {
			await queryClient.invalidateQueries({ queryKey: SMART_KEY });
			if (active === id) {
				await navigate({ to: "/" });
			}
		},
	});
	const error = create.error ?? remove.error;

	return (
		<div className="space-y-0.5">
			<GroupHeading
				label="Smart playlists"
				icon={<Sparkles />}
				open={!closed}
				onToggle={() => setClosed(!closed)}
				action={
					<AddButton
						label="New smart playlist"
						className={HOVER_ACTION}
						onClick={() => {
							setClosed(false);
							create.mutate();
						}}
					/>
				}
			/>
			{!closed && (list.data ?? []).length === 0 && (
				<p className="py-1 pr-2 text-muted-foreground text-xs" style={{ paddingLeft: CHILD_PAD }}>
					Playlists that fill themselves from tags and filters.
				</p>
			)}
			{(closed ? [] : (list.data ?? [])).map((p) => (
				<RowMenu
					key={p.id}
					label={p.name}
					items={[
						{
							label: "Delete…",
							icon: <Trash2 />,
							destructive: true,
							onSelect: () => setDeleting(p),
						},
					]}
				>
					<div className={rowClass(active === p.id)}>
						<Link
							to="/smart/$id"
							params={{ id: String(p.id) }}
							className={rowBase}
							style={{ paddingLeft: CHILD_PAD }}
						>
							<Sparkles className="size-4 shrink-0" />
							<span className="truncate">{p.name}</span>
						</Link>
						<span className="size-5 shrink-0" />
					</div>
				</RowMenu>
			))}
			{error && <p className="px-2 text-destructive text-xs">{String(error)}</p>}
			{deleting && (
				<ConfirmDialog
					title={`Delete smart playlist “${deleting.name}”?`}
					confirmLabel="Delete smart playlist"
					destructive
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						const { id } = deleting;
						setDeleting(null);
						remove.mutate(id);
					}}
				>
					Its rules go. The songs stay in your library, and drives keep it until their next export.
				</ConfirmDialog>
			)}
		</div>
	);
}
