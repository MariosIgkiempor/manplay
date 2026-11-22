import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { removeSyncTarget, type SyncTarget, targetShortName } from "#/lib/api.ts";

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
	const remove = useMutation({
		mutationFn: (target: SyncTarget) => removeSyncTarget(target.id),
		onSuccess: async (_, target) => {
			onRemoved?.(target);
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
		},
	});
	const dialog = asking && (
		<ConfirmDialog
			title={`Remove ${targetShortName(asking)}?`}
			confirmLabel="Remove destination"
			destructive
			busy={remove.isPending}
			onCancel={() => setAsking(null)}
			onConfirm={() => {
				remove.mutate(asking);
				setAsking(null);
			}}
		>
			{removalConsequence(asking)}
		</ConfirmDialog>
	);
	return {
		ask: setAsking,
		remove: remove.mutate,
		dialog,
		error: remove.error,
		busy,
		removing: remove.isPending,
	};
}
