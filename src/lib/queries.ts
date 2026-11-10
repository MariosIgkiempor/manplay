import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listSyncTargets, listTracks, syncRun } from "#/lib/api.ts";

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
