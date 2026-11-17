import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { CollectionHeader } from "#/components/page-header.tsx";
import { SelectableTrackList } from "#/components/selectable-track-list.tsx";
import { SharingControl } from "#/components/sharing-control.tsx";
import { SmartRulesEditor } from "#/components/smart-playlists.tsx";
import { deleteSmartPlaylist, type SmartPlaylist, saveSmartPlaylist } from "#/lib/api.ts";
import { duration } from "#/lib/format.ts";
import { useTracks } from "#/lib/queries.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { SMART_KEY, useSmartPreview } from "#/lib/use-smart.ts";

/** A smart playlist: its rules, and the songs they pick from the library right now. */
export function SmartPlaylistView({ playlist }: { playlist: SmartPlaylist }) {
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

	return (
		<main>
			<CollectionHeader
				kind={
					<>
						<Sparkles className="size-3.5" /> Smart playlist
					</>
				}
				title={playlist.name}
				meta={
					<>
						<span>
							{songs.length} {songs.length === 1 ? "song" : "songs"} right now
						</span>
						{seconds >= 1 && <span>{duration(seconds)}</span>}
					</>
				}
				tracks={songs}
				fallbackIcon={<Sparkles className="size-10" />}
				onRename={(name) => name.trim() && rename.mutate(name.trim())}
				onDelete={() => setConfirming(true)}
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
			<div className="space-y-8 p-6">
				{[rename, destroy].map(
					(m) => m.isError && <ErrorLine key={m.submittedAt}>{String(m.error)}</ErrorLine>,
				)}
				<section className="space-y-3">
					<h2 className={typeScale.sectionTitle}>Rules</h2>
					<SmartRulesEditor playlist={playlist} />
				</section>
				<section className="space-y-3">
					<h2 className={typeScale.sectionTitle}>Songs</h2>
					{songs.length === 0 && !preview.isPending ? (
						<EmptyState icon={<Sparkles />} title="No song matches every rule">
							Take a tag or filter out to widen it. Songs join on their own as you tag them.
						</EmptyState>
					) : (
						<SelectableTrackList tracks={songs} />
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
					Its rules go. The songs stay in your library, and drives keep it until their next export.
				</ConfirmDialog>
			)}
		</main>
	);
}
