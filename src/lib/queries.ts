import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fsCopy,
	fsMakeDir,
	fsMove,
	fsRename,
	fsTrash,
	getLibraryRoot,
	itunesImport,
	libraryStatus,
	listSyncTargets,
	listTracks,
	pickAndScan,
	removeMissingNow,
	rescanLibrary,
	syncRun,
} from "#/lib/api.ts";

export function useTracks() {
	return useQuery({ queryKey: ["tracks"], queryFn: listTracks });
}

export function useSyncTargets() {
	return useQuery({ queryKey: ["sync-targets"], queryFn: listSyncTargets });
}

/** Mutation that syncs one target (pass its id) or all targets (pass undefined). */
export function useSyncRun() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (targetId?: number) => syncRun(targetId),
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
		["fs", "tracks", "playlists", "tags", "library-status"].map((k) =>
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
