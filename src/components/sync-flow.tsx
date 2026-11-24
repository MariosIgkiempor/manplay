import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import type { SyncMode } from "#/components/sync-summary.tsx";
import { Button } from "#/components/ui/button.tsx";
import { type SyncKind, useSyncActions } from "#/context/sync-actions-context.ts";
import { useSyncTargets } from "#/lib/queries.ts";

interface Props {
	/** Destinations to act on; every destination when omitted. */
	ids?: number[];
	size?: "sm" | "default";
	variant?: "default" | "outline";
	disabled?: boolean;
}

function useIds(ids: number[] | undefined) {
	const targets = useSyncTargets();
	return ids ?? targets.data?.map((t) => t.id) ?? [];
}

/** Opens the sync review for every destination, or the ones `ids` names. */
export function SyncButton({
	ids,
	size,
	variant,
	disabled,
	label = "Sync",
}: Props & { label?: string }) {
	const all = useIds(ids);
	const { start } = useSyncActions();
	return (
		<Button
			size={size}
			variant={variant}
			disabled={disabled === true || all.length === 0}
			data-hint="Shows what a sync would change; nothing changes until you confirm."
			onClick={() => start("sync", ids)}
		>
			<RefreshCw /> {label}
		</Button>
	);
}

const modeOf = (kind: SyncKind): SyncMode => (kind === "sync" ? "both" : kind);

/**
 * Takes a sync asked for from anywhere to the page that reviews it: a lone destination's own
 * page, or the one review of several. No slide-over: the review is a place, with a way back.
 */
export function SyncRequests() {
	const { request, close } = useSyncActions();
	const navigate = useNavigate();
	const targets = useSyncTargets();
	const known = targets.data;
	useEffect(() => {
		if (!(request && known)) {
			return;
		}
		const ids = request.ids ?? known.map((t) => t.id);
		const mode = modeOf(request.kind);
		const [only] = ids;
		if (ids.length === 1 && only !== undefined) {
			void navigate({ to: "/export/$targetId", params: { targetId: only }, search: { mode } });
		} else {
			void navigate({ to: "/export/sync", search: { mode, ids: request.ids } });
		}
		close();
	}, [request, known, navigate, close]);
	return null;
}
