import { useMutation, useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const UPDATE_KEY = ["app-update"] as const;

export function useAppVersion() {
	return useQuery({
		queryKey: ["app-version"],
		queryFn: getVersion,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/** Checks GitHub releases once at launch (cached for the session); `refetch` re-checks on demand. */
export function useUpdateCheck() {
	return useQuery({
		queryKey: UPDATE_KEY,
		queryFn: async () => (await check()) ?? null,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		refetchOnWindowFocus: false,
	});
}

/** Downloads and installs the pending update, then restarts the app. */
export function useInstallUpdate() {
	return useMutation({
		mutationFn: async () => {
			const update = await check();
			if (!update) {
				return;
			}
			await update.downloadAndInstall();
			await relaunch();
		},
	});
}
