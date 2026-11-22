import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListMusic, Send } from "lucide-react";
import { useState } from "react";
import { SettingLabel } from "#/components/destination-header.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { type ChooserTab, ExportChooser, ExportFooter } from "#/components/export-chooser.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { SettingRow } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	type ExportSelection,
	jellyfinServerPlaylists,
	listPlaylists,
	listTags,
	setJellyfinSelection,
	type Tag,
} from "#/lib/api.ts";
import { EMPTY_SELECTION, plural } from "#/lib/export-selection.ts";
import { WELL_ROWS } from "#/lib/page-layout.ts";
import { useJellyfinDestinations } from "#/lib/queries.ts";
import { useSmartPlaylists } from "#/lib/use-smart.ts";

/** How many chosen items still exist (a deleted playlist can linger in a saved choice). */
function useChosenCount(selection: ExportSelection): number {
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const smart = useSmartPlaylists();
	const ids = new Set((playlists.data ?? []).map((p) => p.id));
	const smartIds = new Set((smart.data ?? []).map((p) => p.id));
	const tagNames = new Set((tags.data ?? []).map((t: Tag) => t.name));
	return (
		selection.playlists.filter((id) => ids.has(id)).length +
		selection.tags.filter((name) => tagNames.has(name)).length +
		selection.smart.filter((id) => smartIds.has(id)).length
	);
}

/** The playlists the Jellyfin user has on the server now. */
function OnServer({ targetId }: { targetId: number }) {
	const playlists = useQuery({
		queryKey: ["jellyfin-server-playlists", targetId],
		queryFn: () => jellyfinServerPlaylists(targetId),
		retry: false,
	});
	if (playlists.isError) {
		return <ErrorLine>{String(playlists.error)}</ErrorLine>;
	}
	if (playlists.isPending) {
		return <p className="text-muted-foreground text-sm">Reading Jellyfin…</p>;
	}
	if (playlists.data.length === 0) {
		return <p className="text-muted-foreground text-sm">No playlists in Jellyfin yet.</p>;
	}
	return (
		<ul className={`${WELL_ROWS} px-4`}>
			{playlists.data.map((p) => (
				<li key={p.name} className="flex justify-between gap-3 py-2 text-sm">
					<span className="truncate">{p.name}</span>
					<span className="shrink-0 text-muted-foreground tabular-nums">
						{plural(p.songs, "song")}
					</span>
				</li>
			))}
		</ul>
	);
}

function Chooser({
	targetId,
	saved,
	onClose,
}: {
	targetId: number;
	saved: ExportSelection;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<ExportSelection | null>(null);
	const [tab, setTab] = useState<ChooserTab>("playlists");
	const selection = draft ?? saved;
	const count = useChosenCount(selection);
	const save = useMutation({
		mutationFn: setJellyfinSelection,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["jellyfin-destinations"] });
			onClose();
		},
	});
	return (
		<div className="flex min-h-full flex-col gap-5">
			<ExportChooser
				selection={selection}
				onChange={setDraft}
				tab={tab}
				onTab={setTab}
				replaces={new Set()}
				onLeave={onClose}
				destination={{
					label: "In Jellyfin",
					icon: <Send />,
					content: <OnServer targetId={targetId} />,
				}}
			/>
			<MutationErrors mutations={[save]} />
			<ExportFooter
				text={`${plural(count, "playlist")}${draft === null ? " chosen" : ", not saved yet"}`}
			>
				<Button variant="ghost" onClick={onClose} disabled={save.isPending}>
					Cancel
				</Button>
				<Button
					onClick={() => save.mutate({ targetId, selection })}
					disabled={draft === null || save.isPending}
				>
					{save.isPending ? "Saving…" : "Save"}
				</Button>
			</ExportFooter>
		</div>
	);
}

/** Which playlists go to this destination's Jellyfin server, as a settings row and a drawer. */
export function JellyfinPlaylistsRow({ targetId }: { targetId: number }) {
	const destinations = useJellyfinDestinations();
	const [open, setOpen] = useState(false);
	const saved =
		destinations.data?.find((d) => d.targetId === targetId)?.selection ?? EMPTY_SELECTION;
	const count = useChosenCount(saved);
	return (
		<SettingRow
			label={
				<SettingLabel
					icon={<ListMusic />}
					title="Playlists"
					hint={
						count === 0
							? "None chosen. Choose here, or from a playlist's ⋯ menu."
							: `${plural(count, "playlist")} chosen. Change here, or from a playlist's ⋯ menu.`
					}
				/>
			}
		>
			<Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
				Choose…
			</Button>
			<Drawer
				open={open}
				onClose={() => setOpen(false)}
				title="Playlists for Jellyfin"
				width="w-[44rem]"
			>
				{open && <Chooser targetId={targetId} saved={saved} onClose={() => setOpen(false)} />}
			</Drawer>
		</SettingRow>
	);
}
