import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useUndo } from "#/context/undo-context.ts";
import {
	type ActivitySource,
	activityHistory,
	analysisFailures,
	analysisSettings,
	analyzeTracks,
	applyFileRemovals,
	auditFix,
	auditLibrary,
	auditPlace,
	type CoverReport,
	carryOver,
	coverSearch,
	DEFAULT_PANEL_TABS,
	discogsTokenForget,
	discogsTokenSave,
	discogsTokenSaved,
	dismissCarry,
	type FixReport,
	fsCopy,
	fsMakeDir,
	fsMove,
	fsRename,
	fsTrash,
	getDefaultScope,
	getDeviceName,
	getLibraryRoot,
	getLibraryView,
	getPanelTabs,
	getTagClipboard,
	getUiSetting,
	type IgnoreRule,
	type ItemKind,
	type JoinChoice,
	jellyfinDestinations,
	jellyfinSettings,
	keepFileRemovals,
	type LeaveChoice,
	libraryStatus,
	libsyncDecideDeletes,
	libsyncHome,
	libsyncJoin,
	libsyncJoinFolder,
	libsyncLeave,
	libsyncSetAuto,
	libsyncStatus,
	libsyncSyncNow,
	listCarryCandidates,
	listClashes,
	listDuplicates,
	listFileRemovals,
	listLibraryChanges,
	listMissing,
	listRecentlyDeleted,
	listSyncTargets,
	listTracks,
	migrateLibraryTags,
	onAnalysisFinished,
	onLibrarySynced,
	type PanelTabs,
	type PlanId,
	pickAndScan,
	type ReleaseId,
	type Resolution,
	removeMissingNow,
	rescanLibrary,
	resetLibrary,
	restoreDeleted,
	type ServiceId,
	type SyncTarget,
	saveAnalysisToFiles,
	serviceFlags,
	setAnalysisSettings,
	setDefaultScope,
	setDeviceName,
	setLibraryView,
	setPanelTabs,
	setServiceEnabled,
	setTagClipboard,
	setUiSetting,
	syncApply,
	syncHistory,
	syncIgnore,
	syncRescan,
	syncScan,
	syncScans,
	syncUnignore,
	type TagPaths,
	type TrashGroup,
	tagsLookup,
	tagsLookupCover,
	tagsPreview,
	tagsRead,
	tagsSetCover,
	tagsWrite,
	tagsWriteMany,
	tagTracks,
	tagValueCreate,
	tagValues,
	tagValuesMigrate,
	trackCues,
	trashDuplicates,
	undoLibraryChanges,
} from "#/lib/api.ts";
import { bumpArt } from "#/lib/art-version.ts";
import type { CoverWrite, LookupWrite } from "#/lib/tag-lookup.ts";
import { undoCoverChange, undoTagWrite } from "#/lib/undo-entries.ts";

/**
 * Every song in the library. It is read once and kept: each change the app makes (an edit, a
 * scan, a sync, an import) marks it stale, and only then is it read again. Reading it on every
 * page that shows songs meant moving and checking the whole library again each time. It is still
 * read again when the window comes back, for changes made to the files outside the app.
 */
export function useTracks() {
	return useQuery({
		queryKey: ["tracks"],
		queryFn: listTracks,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: "always",
	});
}

export const cuesKey = (trackId: number) => ["track-cues", trackId] as const;

/** A song's hot and memory cues; `trackId` null asks for nothing. */
export function useTrackCues(trackId: number | null) {
	return useQuery({
		queryKey: cuesKey(trackId ?? -1),
		queryFn: () => trackCues(trackId ?? -1),
		enabled: trackId !== null,
	});
}

const HISTORY_LIMIT = 200;

export function useSyncHistory() {
	return useQuery({ queryKey: ["sync-history"], queryFn: () => syncHistory(HISTORY_LIMIT) });
}

/** Several sources' past runs at once, in the order of `sources`. */
export function useActivities(sources: readonly ActivitySource[]) {
	return useQueries({
		queries: sources.map((source) => ({
			queryKey: ["activity", source],
			queryFn: () => activityHistory(source, HISTORY_LIMIT),
		})),
	});
}

export function useActivity(source: ActivitySource) {
	return useQuery({
		queryKey: ["activity", source],
		queryFn: () => activityHistory(source, HISTORY_LIMIT),
	});
}

export function useSyncTargets() {
	return useQuery({ queryKey: ["sync-targets"], queryFn: listSyncTargets });
}

/** Every destination with a Jellyfin server, with the playlists it sends. */
export function useJellyfinDestinations() {
	return useQuery({ queryKey: ["jellyfin-destinations"], queryFn: jellyfinDestinations });
}

/** The Jellyfin server saved for a destination, or null. */
export function useJellyfinSettings(targetId: number) {
	return useQuery({
		queryKey: ["jellyfin", targetId],
		queryFn: () => jellyfinSettings(targetId),
	});
}

export const LIBRARY_HOME_KEY = ["library-home"] as const;

/** Where this device's shared library is kept, if it is in one. */
export function useLibraryHome() {
	return useQuery({ queryKey: LIBRARY_HOME_KEY, queryFn: libsyncHome });
}

/** Whether this device is in a shared library: until then nothing is sent to anyone. */
export function useSharingOn() {
	const home = useLibraryHome().data;
	return home !== undefined && home.kind !== "none";
}

export const CLASHES_KEY = ["clashes"] as const;

/** Two items with one name, waiting for the user (tags, playlists, smart playlists). */
export function useClashes() {
	return useQuery({ queryKey: CLASHES_KEY, queryFn: listClashes });
}

export const DELETED_KEY = ["recently-deleted"] as const;

/** Shared items deleted in the last 90 days, who deleted them and when. */
export function useRecentlyDeleted() {
	return useQuery({ queryKey: DELETED_KEY, queryFn: listRecentlyDeleted });
}

/** Everything a share, a make-private, a hide or a clash choice can change in the lists. */
export function useRefreshItems() {
	const queryClient = useQueryClient();
	return async () => {
		await Promise.all(
			[
				CLASHES_KEY,
				DELETED_KEY,
				["tags"],
				["playlists"],
				["smart-playlists"],
				["tracks"],
				["playlist-tracks"],
			].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
		);
	};
}

/** Takes a deleted item back; the lists and the deleted list refresh. */
export function useRestoreDeleted() {
	const refresh = useRefreshItems();
	return useMutation({
		mutationFn: ({ kind, uid }: { kind: ItemKind; uid: string }) => restoreDeleted(kind, uid),
		onSettled: refresh,
	});
}

/** Where a shared library can be kept: on a destination, or in the library folder itself. */
export type LibraryPlace = { kind: "target"; target: SyncTarget } | { kind: "folder" };

/**
 * Joins or starts a shared library on a destination or in the library folder, and says what the
 * first sync could not do (null when it all went through). Everything shared changes in the lists.
 */
export function useJoinLibrary() {
	const queryClient = useQueryClient();
	const refresh = useRefreshItems();
	return useMutation({
		mutationFn: async ({
			place,
			choice,
		}: {
			place: LibraryPlace;
			choice: JoinChoice;
		}): Promise<string | null> =>
			place.kind === "target"
				? (await libsyncJoin(place.target.id, choice)).error
				: (await libsyncJoinFolder(choice)).error,
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: LIBRARY_HOME_KEY });
			await refresh();
		},
	});
}

export const LIBRARY_SYNC_KEY = ["library-sync-status"] as const;
export const LIBRARY_CHANGES_KEY = ["library-changes"] as const;
export const FILE_REMOVALS_KEY = ["file-removals"] as const;

/** The shared library's syncing: on its own or not, how the last one went, what it holds back. */
export function useLibrarySyncStatus() {
	return useQuery({
		queryKey: LIBRARY_SYNC_KEY,
		queryFn: libsyncStatus,
		enabled: useSharingOn(),
	});
}

/**
 * Follows the shared library's syncs, which the backend runs on its own: the sync status and the
 * list of changes refresh after each one, and the lists when something arrived. Mount it once.
 */
export function useLibrarySyncWatch() {
	const queryClient = useQueryClient();
	const refresh = useRefreshItems();
	// `refresh` is a new function every render; the subscription must not follow it.
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	useEffect(() => {
		const stop = onLibrarySynced((last) => {
			void queryClient.invalidateQueries({ queryKey: LIBRARY_SYNC_KEY });
			if (last.received > 0) {
				void queryClient.invalidateQueries({ queryKey: FILE_REMOVALS_KEY });
				void queryClient.invalidateQueries({ queryKey: LIBRARY_CHANGES_KEY });
				void refreshRef.current();
			}
		});
		return () => {
			void stop.then((unlisten) => unlisten());
		};
	}, [queryClient]);
}

/** Switches the shared library's own syncing on or off. */
export function useSetLibraryAuto() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: libsyncSetAuto,
		onSettled: () => queryClient.invalidateQueries({ queryKey: LIBRARY_SYNC_KEY }),
	});
}

/** Asks for a sync of the shared library now; `useLibrarySyncWatch` shows what it did. */
export function useSyncLibraryNow() {
	return useMutation({ mutationFn: libsyncSyncNow });
}

/** Settles held deletions: let them through, or keep the items. */
export function useDecideDeletes() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: libsyncDecideDeletes,
		onSettled: () => queryClient.invalidateQueries({ queryKey: LIBRARY_SYNC_KEY }),
	});
}

/** What other devices' edits changed here in the last 30 days, one entry per sync. */
export function useLibraryChanges() {
	return useQuery({
		queryKey: LIBRARY_CHANGES_KEY,
		queryFn: listLibraryChanges,
		enabled: useSharingOn(),
	});
}

/** The songs another device removed from the shared library that are still here. */
export function useFileRemovals() {
	return useQuery({
		queryKey: FILE_REMOVALS_KEY,
		queryFn: listFileRemovals,
		enabled: useSharingOn(),
	});
}

/** Settles removed songs: `keep` brings them back for everyone, `remove` trashes them here. */
export function useSettleFileRemovals() {
	const queryClient = useQueryClient();
	const refresh = useRefreshItems();
	return useMutation({
		mutationFn: ({ choice, audioFps }: { choice: "keep" | "remove"; audioFps: string[] }) =>
			choice === "keep" ? keepFileRemovals(audioFps) : applyFileRemovals(audioFps),
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: FILE_REMOVALS_KEY });
			await refresh();
		},
	});
}

/** Takes one sync's changes back for everyone; the lists and the list of changes refresh. */
export function useUndoLibraryChanges() {
	const queryClient = useQueryClient();
	const refresh = useRefreshItems();
	return useMutation({
		mutationFn: undoLibraryChanges,
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: LIBRARY_CHANGES_KEY });
			await refresh();
		},
	});
}

/** Leaves the shared library; the lists drop or keep the shared items. */
export function useLeaveLibrary() {
	const queryClient = useQueryClient();
	const refresh = useRefreshItems();
	return useMutation({
		mutationFn: ({ choice, sync }: { choice: LeaveChoice; sync: boolean }) =>
			libsyncLeave(choice, sync),
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: LIBRARY_HOME_KEY });
			await refresh();
		},
	});
}

/** This device's name as other members of a shared library see it. */
export function useDeviceName() {
	const queryClient = useQueryClient();
	const name = useQuery({ queryKey: ["device-name"], queryFn: getDeviceName });
	const save = useMutation({
		mutationFn: setDeviceName,
		onSuccess: (next) => queryClient.setQueryData(["device-name"], next),
	});
	return { name, save };
}

/** The scope new tags and playlists get, and the means to change it. */
export function useDefaultScope() {
	const queryClient = useQueryClient();
	const scope = useQuery({ queryKey: ["default-scope"], queryFn: getDefaultScope });
	const save = useMutation({
		mutationFn: setDefaultScope,
		onSuccess: (_, next) => queryClient.setQueryData(["default-scope"], next),
	});
	return { scope, save };
}

export const SYNC_KEY = ["sync-run"] as const;

/** Every query fed by the background reads of the destinations; refetched on `sync-scan` events. */
export const SYNC_SCANS_KEY = ["sync-scans"] as const;

/** What the background reads found per destination, and which are waiting or being read. */
export function useSyncScans() {
	return useQuery({ queryKey: [...SYNC_SCANS_KEY, "status"], queryFn: syncScans });
}

const targetScanQuery = (targetId: number) => ({
	queryKey: [...SYNC_SCANS_KEY, "target", targetId],
	queryFn: () => syncScan(targetId),
});

/** The latest read of one destination in full; null before its first read. */
export function useTargetScan(targetId: number) {
	return useQuery(targetScanQuery(targetId));
}

/** The latest reads of several destinations, in the order given. */
export function useTargetScans(targetIds: readonly number[]) {
	return useQueries({ queries: targetIds.map(targetScanQuery) });
}

/** Ignores or unignores destination-only files of one destination, then shows its read again. */
export function useSyncIgnore() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			targetId,
			rules,
			ignored,
		}: {
			targetId: number;
			rules: IgnoreRule[];
			ignored: boolean;
		}) => (ignored ? syncIgnore(targetId, rules) : syncUnignore(targetId, rules)),
		onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_SCANS_KEY }),
	});
}

/** Reads destinations again ahead of anything else waiting, e.g. on Refresh. */
export function useSyncRescan() {
	return useMutation({ mutationFn: (ids: number[]) => syncRescan(ids) });
}

/** Runs the actions of a reviewed plan that the user confirmed. */
export function useSyncApply() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: SYNC_KEY,
		mutationFn: ({
			planIds,
			actionIds,
			resolutions,
		}: {
			planIds: PlanId[];
			actionIds: number[];
			resolutions?: Record<number, Resolution>;
		}) => syncApply(planIds, actionIds, resolutions),
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
		},
	});
}

export function useLibraryRoot() {
	return useQuery({ queryKey: ["library-root"], queryFn: getLibraryRoot });
}

export function useLibraryStatus() {
	return useQuery({ queryKey: ["library-status"], queryFn: libraryStatus });
}

/** Tracks whose files are gone; only fetched while `enabled` (the list drawer is open). */
export function useMissingTracks(enabled: boolean) {
	return useQuery({ queryKey: ["missing-tracks"], queryFn: listMissing, enabled });
}

/** Songs stored more than once (same audio); re-run after any file change. */
export function useDuplicates() {
	return useQuery({
		queryKey: ["duplicates"],
		queryFn: listDuplicates,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** Re-encoded songs whose old audio has tags or playlists to carry over. */
export function useCarryCandidates() {
	return useQuery({
		queryKey: ["carry"],
		queryFn: listCarryCandidates,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** Carries tags and playlists over to the new audio, or leaves them (`trackId` null). */
export function useCarryDecision() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ oldFp, trackId }: { oldFp: string; trackId: number | null }) => {
			if (trackId === null) {
				await dismissCarry(oldFp);
			} else {
				await carryOver(oldFp, trackId);
			}
		},
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

/** Ends the grace period for missing tracks. Their remote copies are offered for deletion at the next sync review. */
export function useRemoveMissing() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: removeMissingNow,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			await queryClient.invalidateQueries({ queryKey: ["missing-tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
		},
	});
}

/** Rebuilds the library database from disk. Does not trigger a sync. */
export function useResetLibrary() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: SCAN_KEY,
		mutationFn: resetLibrary,
		onSettled: async () => {
			for (const key of ["tracks", "library-root", "library-status", "playlists", "tags"]) {
				await queryClient.invalidateQueries({ queryKey: [key] });
			}
		},
	});
}

export const ANALYSIS_KEY = ["analysis"] as const;

/**
 * Detects BPM and key. `trackIds` omitted analyzes every track not analyzed yet; with ids,
 * those tracks are analyzed again.
 */
export function useAnalyze() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: ANALYSIS_KEY,
		mutationFn: (trackIds?: number[]) => analyzeTracks(trackIds, trackIds !== undefined),
		onSettled: () => refreshAfterAnalysis(queryClient),
	});
}

/** Analyzes songs afresh, discarding the BPM, key and grid set on them by hand. */
export function useRedetect() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: ANALYSIS_KEY,
		mutationFn: (trackIds: number[]) => analyzeTracks(trackIds, true, true),
		onSettled: () => refreshAfterAnalysis(queryClient),
	});
}

/** Shows the results of every analysis run as it ends, background runs included. Mounted once. */
export function useAnalysisResults() {
	const queryClient = useQueryClient();
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void onAnalysisFinished(() => void refreshAfterAnalysis(queryClient)).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [queryClient]);
}

async function refreshAfterAnalysis(queryClient: ReturnType<typeof useQueryClient>) {
	for (const key of [
		"tracks",
		"playlist-tracks",
		"analysis-failures",
		"tag-values",
		"track-analysis",
	]) {
		await queryClient.invalidateQueries({ queryKey: [key] });
	}
}

/** Writes every saved BPM and key result into the files' tags. */
export function useSaveAnalysisToFiles() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: ANALYSIS_KEY,
		mutationFn: saveAnalysisToFiles,
		onSettled: () => refreshAfterAnalysis(queryClient),
	});
}

export function useAnalysisSettings() {
	return useQuery({ queryKey: ["analysis-settings"], queryFn: analysisSettings });
}

export function useSetAnalysisSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: setAnalysisSettings,
		onMutate: (next) => queryClient.setQueryData(["analysis-settings"], next),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ["analysis-settings"] }),
	});
}

/** Songs whose analysis failed; only fetched while `enabled`. */
export function useAnalysisFailures(enabled: boolean) {
	return useQuery({ queryKey: ["analysis-failures"], queryFn: analysisFailures, enabled });
}

export const SCAN_KEY = ["scan"] as const;

export type ScanMode = "saved" | "changed" | "pick";

/**
 * Scans the library: `"saved"` reads every file of the remembered folder again, `"changed"` only
 * its new and changed files (what a launch does), `"pick"` asks for a new folder.
 * Nothing is sent to a sync destination until it is reviewed and confirmed in Export.
 */
export function useScan() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: SCAN_KEY,
		mutationFn: (mode: ScanMode) =>
			mode === "pick" ? pickAndScan() : rescanLibrary(mode === "saved"),
		onSuccess: async (count) => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-root"] });
			// A new folder leaves the shared library the old one held.
			await queryClient.invalidateQueries({ queryKey: LIBRARY_HOME_KEY });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			await queryClient.invalidateQueries({ queryKey: ["playlists"] });
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
			if (count === null) {
				return;
			}
		},
	});
}

/** Everything that can change when files move on disk (the backend rescans afterwards). */
export async function refreshAfterFsChange(queryClient: ReturnType<typeof useQueryClient>) {
	await Promise.all(
		[
			"fs",
			"tracks",
			"playlists",
			"tags",
			"library-status",
			"audit",
			"tag-values",
			"duplicates",
			"carry",
		].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
	);
}

export function useFsMakeDir() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ parent, name }: { parent: string; name: string }) => fsMakeDir(parent, name),
		onSettled: () => queryClient.invalidateQueries({ queryKey: ["fs"] }),
	});
}

export function useFsRename() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ path, newName }: { path: string; newName: string }) => fsRename(path, newName),
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

export function useFsCopy() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ paths, dest }: { paths: string[]; dest: string }) => fsCopy(paths, dest),
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

export function useFsTrash() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (paths: string[]) => fsTrash(paths),
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

export function useTrashDuplicates() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (groups: TrashGroup[]) => trashDuplicates(groups),
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

export function useFsMove() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ paths, dest }: { paths: string[]; dest: string }) => fsMove(paths, dest),
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

/** Library health findings; re-run automatically after any file change. */
export function useAudit() {
	return useQuery({
		queryKey: ["audit"],
		queryFn: auditLibrary,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function useAuditFix() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (paths: string[]) => auditFix(paths),
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

/** Tags shared by the songs at or under `path`. */
export function useTagsRead(path: TagPaths) {
	return useQuery({
		queryKey: ["file-tags", path],
		queryFn: () => tagsRead(path),
		gcTime: 0,
	});
}

/** Known values of a tag field (artists, genres, ...), refreshed by every scan. */
export function useTagValues(field: string, enabled: boolean) {
	return useQuery({
		queryKey: ["tag-values", field],
		queryFn: () => tagValues(field),
		enabled,
		staleTime: 30_000,
	});
}

/** Library tab last used, stored in the database. `view` is null until it has loaded. */
export function useLibraryView() {
	const queryClient = useQueryClient();
	const query = useQuery({ queryKey: ["library-view"], queryFn: getLibraryView });
	const set = useMutation({
		mutationFn: setLibraryView,
		onMutate: (view) => queryClient.setQueryData(["library-view"], view),
		onError: () => queryClient.invalidateQueries({ queryKey: ["library-view"] }),
	});
	return { view: query.data ?? null, setView: set.mutate };
}

/**
 * A display preference kept in the database (e.g. how a list is sorted). `parse` turns what was
 * stored into a value, or null to use `fallback`.
 */
export function useUiSetting<T>(name: string, fallback: T, parse: (raw: unknown) => T | null) {
	const queryClient = useQueryClient();
	const key = ["ui-setting", name];
	const query = useQuery({ queryKey: key, queryFn: () => getUiSetting(name) });
	const set = useMutation({
		mutationFn: (next: T) => setUiSetting(name, next),
		onMutate: (next) => queryClient.setQueryData(key, next),
		onError: () => queryClient.invalidateQueries({ queryKey: key }),
	});
	const value = query.data === undefined ? fallback : (parse(query.data) ?? fallback);
	return [value, set.mutate] as const;
}

/** Tabs last picked in the song and album views, stored in the database. */
export function usePanelTabs() {
	const queryClient = useQueryClient();
	const query = useQuery({ queryKey: ["panel-tabs"], queryFn: getPanelTabs });
	const tabs = query.data ?? DEFAULT_PANEL_TABS;
	const set = useMutation({
		mutationFn: setPanelTabs,
		// A first load still in flight would land after this and undo the pick: drop it first.
		onMutate: async (next) => {
			await queryClient.cancelQueries({ queryKey: ["panel-tabs"] });
			queryClient.setQueryData(["panel-tabs"], next);
		},
		onError: () => queryClient.invalidateQueries({ queryKey: ["panel-tabs"] }),
	});
	const setTab = <K extends keyof PanelTabs>(which: K, value: PanelTabs[K]) => {
		const now = queryClient.getQueryData<PanelTabs>(["panel-tabs"]) ?? tabs;
		if (now[which] !== value) {
			set.mutate({ ...now, [which]: value });
		}
	};
	return { tabs, setTab };
}

/** Tags copied in the Files view, stored in the database. */
export function useTagClipboard() {
	const queryClient = useQueryClient();
	const query = useQuery({ queryKey: ["tag-clipboard"], queryFn: getTagClipboard });
	const set = useMutation({
		mutationFn: setTagClipboard,
		onMutate: (clip) => queryClient.setQueryData(["tag-clipboard"], clip),
		onError: () => queryClient.invalidateQueries({ queryKey: ["tag-clipboard"] }),
	});
	return { clip: query.data ?? null, setClip: set.mutate };
}

export function useTagsWrite() {
	const queryClient = useQueryClient();
	const { record } = useUndo();
	return useMutation({
		mutationFn: async ({ path, edits }: { path: TagPaths; edits: Record<string, string> }) => {
			// Remember the old values first so the edit can be undone.
			const before = await tagsPreview(path, edits).catch(() => null);
			const report = await tagsWrite(path, edits);
			const entry = before && undoTagWrite(before);
			if (entry && report.fixed > 0) {
				record(entry);
			}
			return report;
		},
		onSettled: async () => {
			await refreshAfterFsChange(queryClient);
			await queryClient.invalidateQueries({ queryKey: ["file-tags"] });
		},
	});
}

/**
 * Fetches and writes each cover in turn. One that cannot be fetched is reported, not thrown.
 * `previous` is what the rewritten songs held before.
 */
async function writeLookupCovers(covers: readonly CoverWrite[]): Promise<CoverReport> {
	const total: CoverReport = { fixed: 0, failed: [], previous: [] };
	for (const cover of covers) {
		try {
			const report = await tagsLookupCover(cover.paths, cover.release);
			total.fixed += report.fixed;
			total.failed.push(...report.failed);
			total.previous.push(...report.previous);
		} catch (e) {
			total.failed.push(...cover.paths.map((path) => ({ path, error: `Cover: ${String(e)}` })));
		}
	}
	if (covers.length > 0) {
		bumpArt();
	}
	return total;
}

/**
 * Writes what was taken from a lookup: each song's tags in one go, undoable as one edit, then
 * each cover, undoable as another. A cover that cannot be fetched is reported and does not stop
 * the rest.
 */
export function useLookupApply() {
	const queryClient = useQueryClient();
	const { record } = useUndo();
	return useMutation({
		mutationFn: async ({ changes, covers }: LookupWrite) => {
			const total: FixReport = { fixed: 0, failed: [] };
			if (changes.length > 0) {
				const report = await tagsWriteMany(
					changes.map((f) => ({
						path: f.path,
						edits: Object.fromEntries(f.changes.map((c) => [c.field, c.to ?? ""])),
					})),
				);
				const entry = undoTagWrite({ total: changes.length, files: changes });
				if (entry && report.fixed > 0) {
					record(entry);
				}
				total.fixed += report.fixed;
				total.failed.push(...report.failed);
			}
			const covered = await writeLookupCovers(covers);
			const coverUndo = undoCoverChange(covered.previous);
			if (coverUndo) {
				record(coverUndo);
			}
			total.fixed += covered.fixed;
			total.failed.push(...covered.failed);
			return total;
		},
		onSettled: async () => {
			await refreshAfterFsChange(queryClient);
			await queryClient.invalidateQueries({ queryKey: ["file-tags"] });
		},
	});
}

/**
 * Looks the songs at or under `path` up online. `attempt` 0 may answer from saved results; a
 * higher one asks again. Waits until `enabled`, since a lookup sends song names outside.
 */
export function useTagLookup(path: TagPaths, attempt: number, enabled: boolean) {
	return useQuery({
		queryKey: ["tag-lookup", path, attempt],
		queryFn: () => tagsLookup(path, attempt > 0),
		enabled,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
	});
}

/** Sets a picture as the cover of every song at or under a path; Undo puts the old covers back. */
export function useTagsSetCover() {
	const queryClient = useQueryClient();
	const { record } = useUndo();
	return useMutation({
		mutationFn: async ({ path, image }: { path: TagPaths; image: Uint8Array }) => {
			const report = await tagsSetCover(path, image);
			const entry = undoCoverChange(report.previous);
			if (entry) {
				record(entry);
			}
			return report;
		},
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

/**
 * Finds releases of the album at `path` to choose a cover from. `attempt` 0 may answer from
 * saved results. Waits until `enabled`: it sends the album's name outside, so it is asked for.
 */
export function useCoverSearch(path: TagPaths, attempt: number, enabled: boolean) {
	return useQuery({
		queryKey: ["cover-search", path, attempt],
		queryFn: () => coverSearch(path, attempt > 0),
		enabled,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
	});
}

/** Sets a release's front cover on every song at or under a path; Undo puts the old ones back. */
export function useLookupCoverSet() {
	const queryClient = useQueryClient();
	const { record } = useUndo();
	return useMutation({
		mutationFn: async ({ path, release }: { path: TagPaths; release: ReleaseId }) => {
			const report = await tagsLookupCover(path, release);
			const entry = undoCoverChange(report.previous);
			if (entry) {
				record(entry);
			}
			return report;
		},
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

/**
 * Files several songs under one artist and album, one after another; a file that fails is
 * reported and the rest carry on, as with `auditFix`.
 */
export function useAuditPlaceMany() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			paths,
			artist,
			album,
		}: {
			paths: readonly string[];
			artist: string;
			album: string;
		}): Promise<FixReport> => {
			const report: { fixed: number; failed: FixReport["failed"] } = { fixed: 0, failed: [] };
			for (const path of paths) {
				try {
					await auditPlace(path, artist, album);
					report.fixed += 1;
				} catch (e) {
					report.failed.push({ path, error: String(e) });
				}
			}
			return report;
		},
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

export function useAuditPlace() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ path, artist, album }: { path: string; artist: string; album: string }) =>
			auditPlace(path, artist, album),
		onSettled: () => refreshAfterFsChange(queryClient),
	});
}

/** Which services are switched on. A service never switched is on once it is set up. */
export function useServices() {
	const queryClient = useQueryClient();
	const flags = useQuery({ queryKey: ["services"], queryFn: serviceFlags });
	const set = useMutation({
		mutationFn: ({ id, enabled }: { id: ServiceId; enabled: boolean }) =>
			setServiceEnabled(id, enabled),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["services"] }),
	});
	return {
		isEnabled: (id: ServiceId, configured: boolean) => {
			const flag = flags.data?.[id];
			return flag === undefined ? configured : flag === "on";
		},
		setEnabled: (id: ServiceId, enabled: boolean) => set.mutate({ id, enabled }),
	};
}

/** The Discogs token: whether one is saved, and saving or forgetting it. */
export function useDiscogsToken() {
	const queryClient = useQueryClient();
	const saved = useQuery({ queryKey: ["discogs-token"], queryFn: discogsTokenSaved });
	const done = () => queryClient.invalidateQueries({ queryKey: ["discogs-token"] });
	const save = useMutation({ mutationFn: discogsTokenSave, onSuccess: done });
	const forget = useMutation({ mutationFn: discogsTokenForget, onSuccess: done });
	return { saved: saved.data ?? false, save, forget };
}

/** Tag database edits. Library tags live in the database; the rest rewrite the songs' files. */
export function useTagDatabaseOps(field: string | "library") {
	const queryClient = useQueryClient();
	const done = async () => {
		await refreshAfterFsChange(queryClient);
		await queryClient.invalidateQueries({ queryKey: ["file-tags"] });
	};
	const create = useMutation({
		mutationFn: async (name: string) => {
			if (field === "library") {
				await tagTracks(name, []);
			} else {
				await tagValueCreate(field, name);
			}
		},
		onSettled: done,
	});
	const migrate = useMutation({
		mutationFn: async ({ from, to }: { from: string[]; to: string | null }) => {
			if (field === "library") {
				await migrateLibraryTags(from, to);
				return null;
			}
			return tagValuesMigrate(field, from, to);
		},
		onSettled: done,
	});
	return { create, migrate };
}
