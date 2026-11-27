import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { HiddenItems, ScopeMark } from "#/components/item-sharing.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { AddButton } from "#/components/sidebar-create.tsx";
import { GroupHeading } from "#/components/sidebar-parts.tsx";
import {
	CHILD_PAD,
	HOVER_ACTION,
	pageRow,
	rowBase,
	rowClass,
	useRowMatch,
} from "#/components/sidebar-row.ts";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { deleteSmartPlaylist, type SmartListing } from "#/lib/api.ts";
import { useItemSharing } from "#/lib/use-item-sharing.tsx";
import { useStoredFlag } from "#/lib/use-pane-width.ts";
import { SMART_KEY, useCreateSmartPlaylist, useSmartPlaylists } from "#/lib/use-smart.ts";

/** Smart playlists in the sidebar: rules kept in the library, songs worked out live. */
export function SidebarSmartPlaylists() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const matchRoute = useRowMatch();
	const list = useSmartPlaylists();
	const create = useCreateSmartPlaylist();
	const [deleting, setDeleting] = useState<SmartListing | null>(null);
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
	const sharing = useItemSharing();
	const error = create.error ?? remove.error ?? sharing.error;
	const everything = list.data ?? [];
	const visible = everything.filter((p) => !p.hidden);
	const itemOf = (p: SmartListing) => ({
		kind: "smart_playlist" as const,
		id: p.id,
		name: p.name,
		scope: p.scope ?? "shared",
	});

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
			{!closed && everything.length === 0 && (
				<p className="py-1 pr-2 text-muted-foreground text-xs" style={{ paddingLeft: CHILD_PAD }}>
					Playlists that fill themselves from tags and filters.
				</p>
			)}
			{(closed ? [] : visible).map((p) => (
				<RowMenu
					key={p.id}
					label={p.name}
					items={[
						...sharing.entries(itemOf(p)),
						"separator",
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
							{...pageRow(p.name)}
							style={{ paddingLeft: CHILD_PAD }}
						>
							<Sparkles className="size-4 shrink-0 opacity-70" />
							<span className="min-w-0 truncate">{p.name}</span>
							<ScopeMark scope={p.scope ?? "shared"} held={p.held ?? false} />
						</Link>
					</div>
				</RowMenu>
			))}
			{!closed && (
				<HiddenItems
					items={everything
						.filter((p) => p.hidden)
						.map((p) => ({ key: String(p.id), name: p.name, item: itemOf(p) }))}
					onUnhide={sharing.unhide}
				/>
			)}
			{sharing.dialogs}
			{error && <ErrorLine className="px-2">{String(error)}</ErrorLine>}
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
					<Facts label="Its rules go. The songs stay in your library, and drives keep it until their next export.">
						<Fact tone="lost">Rules</Fact>
						<Fact tone="kept">Songs</Fact>
						<Fact tone="kept">On drives until next export</Fact>
					</Facts>
				</ConfirmDialog>
			)}
		</div>
	);
}
