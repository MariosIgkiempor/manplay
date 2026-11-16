import { CloudUpload, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { SyncPanel } from "#/components/sync-summary.tsx";
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

/** Opens a review of what would be copied from the destinations into this library. */
export function PullButton({ ids, size, variant = "outline", disabled }: Props) {
	const all = useIds(ids);
	const { start } = useSyncActions();
	return (
		<Button
			size={size}
			variant={variant}
			disabled={disabled === true || all.length === 0}
			title="Copy songs your library is missing from destinations. A pull never deletes."
			onClick={() => start("pull", ids)}
		>
			<Download /> Review pull
		</Button>
	);
}

/** Sync = pull and push, each with its own review. */
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
			title="Shows what a pull and a push would change, then runs both once confirmed."
			onClick={() => start("sync", ids)}
		>
			<RefreshCw /> {label}
		</Button>
	);
}

/** Button that opens the push review: nothing reaches a destination until it is confirmed. */
export function PushButton({
	ids,
	label = "Review push",
	size,
	variant,
	disabled,
}: Props & { label?: string }) {
	const { start } = useSyncActions();
	return (
		<Button
			size={size}
			variant={variant}
			disabled={disabled}
			title="See what will be sent, moved or deleted before anything changes."
			onClick={() => start("push", ids)}
		>
			<CloudUpload /> {label}
		</Button>
	);
}

const ABOUT: Record<SyncKind, string> = {
	sync: "Pull what your library is missing, then push your changes.",
	pull: "Copy songs your library is missing. A pull never deletes.",
	push: "Send, move and change files on destinations.",
};

/** The page header every other panel has: icon tile, title and a line on what this run does. */
function SyncHeader({ kind }: { kind: SyncKind }) {
	return (
		<PageHeader
			variant="plain"
			art={
				<div className="grid size-16 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/20 [&_svg]:size-7">
					<RefreshCw />
				</div>
			}
			title="Sync with destinations"
			subtitle={ABOUT[kind]}
		/>
	);
}

/**
 * The slide-over for syncing every destination, or the ones a button names. One panel with a
 * switch for each pull and push; the buttons only decide which start switched on.
 */
export function SyncDrawers() {
	const { request, close } = useSyncActions();
	const all = useIds(request?.ids);
	// Keep the last kind while the drawer slides out.
	const [last, setLast] = useState<SyncKind>("sync");
	useEffect(() => {
		if (request) {
			setLast(request.kind);
		}
	}, [request]);
	const kind = request?.kind ?? last;
	return (
		<Drawer
			open={request !== null}
			onClose={close}
			title="Sync"
			width="w-[44rem]"
			header={<SyncHeader kind={kind} />}
			bare
		>
			{request && (
				<SyncPanel
					key={request.session}
					ids={all}
					mode={request.kind === "sync" ? "both" : request.kind}
					onClose={close}
				/>
			)}
		</Drawer>
	);
}
