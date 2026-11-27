import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { FrameSection } from "#/components/frame.tsx";
import { useJellyfinMenu } from "#/components/jellyfin-menu.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { CollectionHeader } from "#/components/page-header.tsx";
import {
	HeaderSongSort,
	SelectableTrackList,
	useSongSort,
} from "#/components/selectable-track-list.tsx";
import { SharingControl } from "#/components/sharing-control.tsx";
import { SmartRulesEditor } from "#/components/smart-playlists.tsx";
import { Fact, Facts, MoreInfo } from "#/components/ui/facts.tsx";
import { deleteSmartPlaylist, type SmartListing, saveSmartPlaylist } from "#/lib/api.ts";
import { duration } from "#/lib/format.ts";
import { PAGE_BODY } from "#/lib/page-layout.ts";
import { useTracks } from "#/lib/queries.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { SMART_KEY, useSmartPreview } from "#/lib/use-smart.ts";

/** A smart playlist: its rules, and the songs they pick from the library right now. */
export function SmartPlaylistView({ playlist }: { playlist: SmartListing }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const tracks = useTracks();
	const preview = useSmartPreview(playlist.rules);
	const songs = useMemo(() => {
		const byId = new Map((tracks.data ?? []).map((t) => [t.id, t]));
		return (preview.data?.trackIds ?? []).flatMap((tid) => byId.get(tid) ?? []);
	}, [tracks.data, preview.data]);
	const seconds = (preview.data?.durationMs ?? 0) / 1000;
	const [confirming, setConfirming] = useState(false);
	const jellyfinMenu = useJellyfinMenu({ kind: "smart", id: playlist.id });

	const rename = useMutation({
		mutationFn: (name: string) => saveSmartPlaylist({ ...playlist, name }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: SMART_KEY }),
	});
	const destroy = useMutation({
		mutationFn: () => deleteSmartPlaylist(playlist.id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: SMART_KEY });
			await navigate({ to: "/" });
		},
	});

	const sort = useSongSort(songs);
	return (
		<main>
			<CollectionHeader
				sort={<HeaderSongSort songs={songs.length} sort={sort} />}
				title={playlist.name}
				meta={
					<>
						<span>
							{songs.length} {songs.length === 1 ? "song" : "songs"}
						</span>
						{seconds >= 1 && <span>{duration(seconds)}</span>}
					</>
				}
				tracks={sort.sorted}
				fallbackIcon={<Sparkles className="size-10" />}
				onRename={(name) => name.trim() && rename.mutate(name.trim())}
				onDelete={() => setConfirming(true)}
				menuExtra={jellyfinMenu}
				sharing={
					<SharingControl
						item={{
							kind: "smart_playlist",
							id: playlist.id,
							name: playlist.name,
							scope: playlist.scope ?? "shared",
						}}
					/>
				}
			/>
			<div className={`space-y-8 ${PAGE_BODY}`}>
				{[rename, destroy].map(
					(m) => m.isError && <ErrorLine key={m.submittedAt}>{String(m.error)}</ErrorLine>,
				)}
				<FrameSection
					title="Rules"
					description={
						<Facts label="Songs join and leave as you tag and analyze them.">
							<Fact tone="changed">Updates as you tag</Fact>
						</Facts>
					}
				>
					<div className="p-4">
						<SmartRulesEditor playlist={playlist} />
					</div>
				</FrameSection>
				<section className="space-y-3">
					<h2 className={typeScale.sectionTitle}>Songs</h2>
					{songs.length === 0 && !preview.isPending ? (
						<EmptyState icon={<Sparkles />} title="No song matches every rule">
							Remove a tag or filter to widen it. <MoreInfo hint="Songs join as you tag them." />
						</EmptyState>
					) : (
						<SelectableTrackList
							tracks={songs}
							sort={sort.sort}
							onSortChange={sort.setSort}
							hideSortMenu
						/>
					)}
				</section>
			</div>
			{confirming && (
				<ConfirmDialog
					title={`Delete smart playlist “${playlist.name}”?`}
					confirmLabel="Delete smart playlist"
					destructive
					busy={destroy.isPending}
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						destroy.mutate();
					}}
				>
					<Facts label="Its rules go. The songs stay in your library, and drives keep it until their next export.">
						<Fact tone="lost">Rules</Fact>
						<Fact tone="kept">Songs</Fact>
						<Fact tone="kept">On drives until next export</Fact>
					</Facts>
				</ConfirmDialog>
			)}
		</main>
	);
}
