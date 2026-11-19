import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { removeSyncTarget, type SyncTarget, targetShortName } from "#/lib/api.ts";

/**
 * Removing a destination from manplay, after a confirmation that says the files there stay: only
 * manplay's record of it goes. `ask` opens the confirmation; render `dialog` somewhere.
 */
export function useRemoveDestination(onRemoved?: (target: SyncTarget) => void): {
	ask: (target: SyncTarget) => void;
	dialog: ReactNode;
	error: Error | null;
	/** A sync is running, so nothing can be removed now. */
	busy: boolean;
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
	const where = (t: SyncTarget) =>
		t.path.length > 0 ? `${t.machine} / ${t.path.join(" / ")}` : `${t.machine} (whole bucket)`;
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
			manplay stops syncing there and forgets it. Nothing is deleted: the files in {where(asking)}{" "}
			stay as they are.
		</ConfirmDialog>
	);
	return { ask: setAsking, dialog, error: remove.error, busy };
}
