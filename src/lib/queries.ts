import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUndo } from "#/context/undo-context.ts";
import {
	type ActivitySource,
	activityHistory,
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
	listSyncTargets,
	listTracks,
	migrateLibraryTags,
	pickAndScan,
	removeMissingNow,
	rescanLibrary,
	resetLibrary,
	type ServiceId,
	serviceFlags,
	setLibraryView,
	setServiceEnabled,
	setTagClipboard,
	syncHistory,
	syncRun,
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

/** Mutation that syncs the given target ids, or every target of an enabled service (pass undefined). */
export function useSyncRun() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (ids?: number[]) => syncRun(ids),
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

/** Ends the grace period for missing tracks, then syncs so remote copies are removed too. */
export function useRemoveMissing() {
	const queryClient = useQueryClient();
	const sync = useSyncRun();
	return useMutation({
		mutationFn: removeMissingNow,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			const targets = await queryClient.ensureQueryData({
				queryKey: ["sync-targets"],
				queryFn: listSyncTargets,
			});
			if (targets.length > 0) {
				sync.mutate(undefined);
			}
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

export const SCAN_KEY = ["scan"] as const;

export type ScanMode = "saved" | "pick";

/**
 * Scans the library: `"saved"` rescans the remembered folder, `"pick"` asks for a new one.
 * New files are mirrored to every sync destination afterwards.
 */
export function useScan() {
	const queryClient = useQueryClient();
	const sync = useSyncRun();
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
			const targets = await queryClient.ensureQueryData({
				queryKey: ["sync-targets"],
				queryFn: listSyncTargets,
			});
			if (targets.length > 0) {
				sync.mutate(undefined);
			}
		},
	});
}

/** Imports new iTunes songs, then refreshes the library and syncs the new files. */
/** Songs waiting in the iTunes folder (empty while iTunes is off or unset). */
export function useItunesPending(enabled: boolean) {
	return useQuery({ queryKey: ["itunes-pending"], queryFn: itunesPending, enabled });
}

export function useItunesImport() {
	const queryClient = useQueryClient();
	const sync = useSyncRun();
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
			const targets = await queryClient.ensureQueryData({
				queryKey: ["sync-targets"],
				queryFn: listSyncTargets,
			});
			if (targets.length > 0) {
				sync.mutate(undefined);
			}
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

/** Tags shared by the song or folder at `path`. */
export function useTagsRead(path: string) {
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
		mutationFn: async ({ path, edits }: { path: string; edits: Record<string, string> }) => {
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
		mutationFn: ({ path, image }: { path: string; image: Uint8Array }) => tagsSetCover(path, image),
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

/** Tag Database edits. Library tags live in the database; the rest rewrite the songs' files. */
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
