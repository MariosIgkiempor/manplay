import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
	itunesImport,
	itunesPending,
	libraryStatus,
	listSyncTargets,
	listTracks,
	pickAndScan,
	removeMissingNow,
	rescanLibrary,
	type ServiceId,
	serviceFlags,
	setServiceEnabled,
	syncHistory,
	syncRun,
} from "#/lib/api.ts";

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
async function refreshAfterFsChange(queryClient: ReturnType<typeof useQueryClient>) {
	await Promise.all(
		["fs", "tracks", "playlists", "tags", "library-status", "audit"].map((k) =>
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
