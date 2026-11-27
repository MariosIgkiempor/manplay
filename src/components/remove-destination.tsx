import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { StreamedLeaveChoice } from "#/components/streamed-leave-choice.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import {
	removeSyncTarget,
	type StreamedOnLeaving,
	type SyncTarget,
	targetShortName,
} from "#/lib/api.ts";
import {
	LIBRARY_HOME_KEY,
	STREAMED_SONGS_KEY,
	useLibraryHome,
	useStreamedSongs,
} from "#/lib/queries.ts";

/** What removing a destination does, for whatever asks the user to confirm it. */
export function removalConsequence(target: SyncTarget): string {
	const where =
		target.path.length > 0
			? `${target.machine} / ${target.path.join(" / ")}`
			: `${target.machine} (whole bucket)`;
	return `manplay stops syncing there and forgets it. Nothing is deleted: the files in ${where} stay as they are.`;
}

/**
 * Removing a destination from manplay, after a confirmation that says the files there stay: only
 * manplay's record of it goes. `ask` opens the confirmation (for menu entries); render `dialog`
 * somewhere. A button confirms in place instead, and calls `remove` on its second press.
 *
 * A destination that holds the shared library this device streams songs from asks what becomes
 * of them first, so `remove` opens that question instead of removing.
 */
export function useRemoveDestination(onRemoved?: (target: SyncTarget) => void): {
	ask: (target: SyncTarget) => void;
	remove: (target: SyncTarget) => void;
	dialog: ReactNode;
	error: Error | null;
	/** A sync is running, so nothing can be removed now. */
	busy: boolean;
	/** A removal is under way. */
	removing: boolean;
} {
	const queryClient = useQueryClient();
	const busy = useSyncProgress().size > 0;
	const [asking, setAsking] = useState<SyncTarget | null>(null);
	const [onLeaving, setOnLeaving] = useState<StreamedOnLeaving>("download");
	const home = useLibraryHome().data;
	const streaming = useStreamedSongs().data;
	const streamedFrom = (target: SyncTarget) =>
		home?.kind === "target" && home.targetId === target.id && streaming?.playable
			? streaming.count
			: 0;
	const remove = useMutation({
		mutationFn: ({
			target,
			streamed,
		}: {
			target: SyncTarget;
			streamed?: StreamedOnLeaving | undefined;
		}) => removeSyncTarget(target.id, streamed),
		onSuccess: async (_, { target }) => {
			onRemoved?.(target);
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: STREAMED_SONGS_KEY });
			await queryClient.invalidateQueries({ queryKey: LIBRARY_HOME_KEY });
		},
	});
	const streamedCount = asking ? streamedFrom(asking) : 0;
	const dialog = asking && (
		<ConfirmDialog
			title={`Remove ${targetShortName(asking)}?`}
			confirmLabel={
				streamedCount > 0 && onLeaving === "download"
					? "Download songs and remove"
					: "Remove destination"
			}
			destructive
			busy={remove.isPending}
			onCancel={() => setAsking(null)}
			onConfirm={() => {
				remove.mutate({ target: asking, streamed: streamedCount > 0 ? onLeaving : undefined });
				setAsking(null);
			}}
		>
			{removalConsequence(asking)}
			{streamedCount > 0 && (
				<StreamedLeaveChoice count={streamedCount} value={onLeaving} onChange={setOnLeaving} />
			)}
		</ConfirmDialog>
	);
	return {
		ask: setAsking,
		remove: (target: SyncTarget) =>
			streamedFrom(target) > 0 ? setAsking(target) : remove.mutate({ target }),
		dialog,
		error: remove.error,
		busy,
		removing: remove.isPending,
	};
}
