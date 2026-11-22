import { Activity, ChevronLeft, ChevronRight, Clock, Disc3, KeyRound, Music } from "lucide-react";
import { type ReactNode, useMemo, useRef } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { ArtistLinks } from "#/components/artist-links.tsx";
import { CoverPicker } from "#/components/cover-picker.tsx";
import { EmptyState } from "#/components/page.tsx";
import { type Fact, PANEL_ART, PanelHeader } from "#/components/panel-header.tsx";
import { SyncBadge } from "#/components/sync-badge.tsx";
import { TagEditor } from "#/components/tag-editor.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail, useDetailNav } from "#/context/detail-context.ts";
import { PanelBarActions, useHasPanelBar } from "#/context/panel-bar.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { albumKey, syncState } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { clock } from "#/lib/format.ts";
import { camelot, formatBpm, keyName } from "#/lib/musical-key.ts";
import { useSyncTargets, useTracks } from "#/lib/queries.ts";
import { tagTargetFor } from "#/lib/tag-target.ts";
import { useShortcut, useShortcutLabel } from "#/lib/use-shortcuts.ts";

/**
 * One song in the left split: its metadata. The beat grid and cues are edited on the deck above
 * the player. `list` is the songs the Previous / Next buttons step through.
 */
export function SongPanel({
	trackId,
	list,
}: {
	trackId: number;
	list: readonly number[] | undefined;
}) {
	const tracks = useTracks();
	const targets = useSyncTargets();
	const go = useDetailNav();
	const track = tracks.data?.find((t) => t.id === trackId);
	if (!track) {
		return <EmptyState title={tracks.isPending ? "Loading song…" : "Song not found"} />;
	}
	const facts = [
		track.durationMs !== null && {
			icon: <Clock />,
			label: clock(track.durationMs / 1000),
			title: "Length",
		},
		track.bpm !== null && { icon: <Activity />, label: formatBpm(track.bpm), title: "BPM" },
		track.key !== null && {
			icon: <KeyRound />,
			label: camelot(track.key) ?? track.key,
			title: keyName(track.key) ?? "Key",
		},
	].filter((f) => f !== false) as Fact[];
	return (
		<div className="pb-8">
			<PanelHeader
				kind={
					<>
						<Music /> Song
					</>
				}
				title={track.title}
				subtitle={<ArtistLinks artist={track.artist} icon />}
				meta={
					<>
						{track.album !== "" && (
							<button
								type="button"
								className="flex min-w-0 max-w-full items-center gap-1 hover:text-foreground hover:underline"
								title={track.album}
								onClick={() => go({ kind: "album", key: albumKey(track.artist, track.album) })}
							>
								<Disc3 aria-hidden="true" className="size-3 shrink-0 opacity-60" />
								<span className="truncate">{track.album}</span>
							</button>
						)}
					</>
				}
				art={
					<CoverPicker paths={track.path} name={track.title}>
						<AlbumArt trackId={track.id} className={PANEL_ART} />
					</CoverPicker>
				}
				tracks={[track]}
				facts={facts}
			/>
			<SongBarActions
				badge={<SyncBadge state={syncState([track], targets.data?.length ?? 0)} />}
				nav={<TrackNav trackId={trackId} list={list} tracks={tracks.data ?? []} />}
			/>
			<SongMetadata track={track} />
		</div>
	);
}

/**
 * Whether the song is synced, then the song stepper, at the end of the panel's top bar beside
 * Close; after the header without a top bar.
 */
function SongBarActions({ badge, nav }: { badge: ReactNode; nav: ReactNode }) {
	const content = (
		<div className="order-last flex items-center gap-1.5 pl-1">
			<span className="grid size-7 place-items-center empty:hidden">{badge}</span>
			{nav}
		</div>
	);
	return useHasPanelBar() ? (
		<PanelBarActions>{content}</PanelBarActions>
	) : (
		<div className="flex justify-end px-5 pt-2">{content}</div>
	);
}

function SongMetadata({ track }: { track: Track }) {
	const target = useMemo(() => tagTargetFor([track]), [track]);
	if (!target) {
		return null;
	}
	return <TagEditor key={track.path} target={target} embedded />;
}

/**
 * Previous and next song of the list, also on [ and ]. The song being left saves first. When
 * the player was playing the song being edited, it moves on with the editor.
 */
function TrackNav({
	trackId,
	list,
	tracks,
}: {
	trackId: number;
	list: readonly number[] | undefined;
	tracks: readonly Track[];
}) {
	const detail = useDetail();
	const player = usePlayer();
	const ids = list ?? [];
	const at = ids.indexOf(trackId);
	const byId = new Map(tracks.map((t) => [t.id, t]));
	const goRef = useRef<(step: number) => void>(() => undefined);
	goRef.current = (step) => {
		const next = ids[at + step];
		if (at < 0 || next === undefined) {
			return;
		}
		if (player.current?.id === trackId && player.playing) {
			const queue = ids.flatMap((id) => byId.get(id) ?? []);
			const index = queue.findIndex((t) => t.id === next);
			if (index >= 0) {
				player.play(queue, index);
			}
		}
		detail.replace({ kind: "song", trackId: next, list });
	};

	// Only while the panel still shows a song.
	const enabled = useRef(false);
	enabled.current = detail.view?.kind === "song";
	useShortcut("prevSong", () => enabled.current && goRef.current(-1));
	useShortcut("nextSong", () => enabled.current && goRef.current(1));
	const prevKey = useShortcutLabel("prevSong");
	const nextKey = useShortcutLabel("nextSong");

	if (at < 0 || ids.length < 2) {
		return null;
	}
	const prev = byId.get(ids[at - 1] ?? -1);
	const next = byId.get(ids[at + 1] ?? -1);
	return (
		<div className="flex items-center gap-0.5 text-muted-foreground text-xs">
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Previous song"
				disabled={!prev}
				title={prev ? `${prev.title}${prevKey ? ` (${prevKey})` : ""}` : undefined}
				onClick={() => goRef.current(-1)}
			>
				<ChevronLeft />
			</Button>
			<span className="min-w-12 whitespace-nowrap text-center tabular-nums">
				{at + 1} of {ids.length}
			</span>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Next song"
				disabled={!next}
				title={next ? `${next.title}${nextKey ? ` (${nextKey})` : ""}` : undefined}
				onClick={() => goRef.current(1)}
			>
				<ChevronRight />
			</Button>
		</div>
	);
}
