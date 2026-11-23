import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { type SyncMode, SyncPanel } from "#/components/sync-summary.tsx";
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

const ABOUT: Record<SyncMode, string> = {
	both: "Send your changes, bring in theirs, and decide about files only they have.",
	pull: "Starts with what comes into your library; nothing is sent.",
	push: "Starts with what goes to destinations; nothing comes in.",
};

const modeOf = (kind: SyncKind): SyncMode => (kind === "sync" ? "both" : kind);

/** The page header every other panel has: icon tile, title and a line on what this run does. */
function SyncHeader({ mode }: { mode: SyncMode }) {
	return (
		<PageHeader
			variant="plain"
			art={
				<div className="grid size-16 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20 [&_svg]:size-7">
					<RefreshCw />
				</div>
			}
			title="Sync with destinations"
			subtitle={ABOUT[mode]}
		/>
	);
}

/**
 * The slide-over for syncing every destination, or the ones a button names: one review of what
 * to send, bring in and settle. Pull or push only decides which direction starts ticked.
 */
export function SyncDrawers() {
	const { request, close } = useSyncActions();
	const all = useIds(request?.ids);
	// Follows the review's direction switch, and stays put while the drawer slides out.
	const [mode, setMode] = useState<SyncMode>("both");
	useEffect(() => {
		if (request) {
			setMode(modeOf(request.kind));
		}
	}, [request]);
	return (
		<Drawer
			open={request !== null}
			onClose={close}
			title="Sync"
			width="w-[44rem]"
			header={<SyncHeader mode={mode} />}
			bare
		>
			{request && (
				<SyncPanel
					key={request.session}
					ids={all}
					mode={modeOf(request.kind)}
					onClose={close}
					onModeChange={setMode}
				/>
			)}
		</Drawer>
	);
}
