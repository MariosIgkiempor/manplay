import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUndo } from "#/context/undo-context.ts";
import {
	type ActivitySource,
	activityHistory,
	analysisFailures,
	analysisSettings,
	analyzeTracks,
	auditFix,
	auditLibrary,
	auditPlace,
	fsCopy,
	fsMakeDir,
	fsMove,
	fsRename,
	fsTrash,
	getLibraryRoot,
	getLibraryView,
	getTagClipboard,
	itunesImport,
	itunesPending,
	libraryStatus,
	listMissing,
	listSyncTargets,
	listTracks,
	migrateLibraryTags,
	pickAndScan,
	removeMissingNow,
	rescanLibrary,
	resetLibrary,
	type ServiceId,
	saveAnalysisToFiles,
	serviceFlags,
	setAnalysisSettings,
	setLibraryView,
	setServiceEnabled,
	setTagClipboard,
	syncApply,
	syncHistory,
	syncPlan,
	type TagPaths,
	tagsPreview,
	tagsRead,
	tagsSetCover,
	tagsWrite,
	tagTracks,
	tagValueCreate,
	tagValues,
	tagValuesMigrate,
} from "#/lib/api.ts";
import { undoTagWrite } from "#/lib/undo-entries.ts";

export function useTracks() {
	return useQuery({ queryKey: ["tracks"], queryFn: listTracks });
}

const HISTORY_LIMIT = 200;

export function useSyncHistory() {
	return useQuery({ queryKey: ["sync-history"], queryFn: () => syncHistory(HISTORY_LIMIT) });
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

export const SYNC_KEY = ["sync-run"] as const;

/** Reads what a sync of the given target ids (or every enabled target) would do. Changes nothing. */
export function useSyncPlan() {
	return useMutation({
		mutationKey: SYNC_KEY,
		mutationFn: (ids?: number[]) => syncPlan(ids),
	});
}

/** Runs the actions of a reviewed plan that the user confirmed. */
export function useSyncApply() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: SYNC_KEY,
		mutationFn: ({ planId, actionIds }: { planId: string; actionIds: number[] }) =>
			syncApply(planId, actionIds),
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

async function refreshAfterAnalysis(queryClient: ReturnType<typeof useQueryClient>) {
	for (const key of ["tracks", "playlist-tracks", "analysis-failures", "tag-values"]) {
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

export type ScanMode = "saved" | "pick";

/**
 * Scans the library: `"saved"` rescans the remembered folder, `"pick"` asks for a new one.
 * Nothing is sent to a sync destination until it is reviewed and confirmed in Export.
 */
export function useScan() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: SCAN_KEY,
		mutationFn: (mode: ScanMode) => (mode === "pick" ? pickAndScan() : rescanLibrary()),
		onSuccess: async (count) => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-root"] });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			await queryClient.invalidateQueries({ queryKey: ["playlists"] });
			await queryClient.invalidateQueries({ queryKey: ["tags"] });
			if (count === null) {
				return;
			}
		},
	});
}

/** Songs waiting in the iTunes folder (empty while iTunes is off or unset). */
export function useItunesPending(enabled: boolean) {
	return useQuery({ queryKey: ["itunes-pending"], queryFn: itunesPending, enabled });
}

export function useItunesImport() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: ["itunes-import"],
		mutationFn: itunesImport,
		onSuccess: async (status) => {
			if (status === null) {
				return;
			}
			queryClient.setQueryData(["itunes"], status);
			await queryClient.invalidateQueries({ queryKey: ["itunes-pending"] });
			if ((status.last?.converted.length ?? 0) === 0) {
				return;
			}
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
		},
	});
}

/** Everything that can change when files move on disk (the backend rescans afterwards). */
export async function refreshAfterFsChange(queryClient: ReturnType<typeof useQueryClient>) {
	await Promise.all(
		["fs", "tracks", "playlists", "tags", "library-status", "audit", "tag-values"].map((k) =>
			queryClient.invalidateQueries({ queryKey: [k] }),
		),
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

export function useTagsSetCover() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ path, image }: { path: TagPaths; image: Uint8Array }) =>
			tagsSetCover(path, image),
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
