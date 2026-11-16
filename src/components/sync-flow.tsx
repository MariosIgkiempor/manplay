import { CloudUpload, Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { PullReview } from "#/components/pull-review.tsx";
import { ReviewBody } from "#/components/sync-review.tsx";
import { SyncSummary } from "#/components/sync-summary.tsx";
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

/** Walks through the pulls of each destination in turn, then calls `onDone`. */
function PullSteps({ ids, onDone }: { ids: number[]; onDone: () => void }) {
	const [step, setStep] = useState(0);
	const id = ids[step];
	if (id === undefined) {
		return null;
	}
	return (
		<div className="space-y-3">
			{ids.length > 1 && (
				<p className="text-muted-foreground text-xs">
					Destination {step + 1} of {ids.length}
				</p>
			)}
			<PullReview
				key={id}
				targetId={id}
				onDone={() => (step + 1 < ids.length ? setStep(step + 1) : onDone())}
			/>
		</div>
	);
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

/** A summary of both steps first; from there, run them or review each one in detail. */
function SyncFlow({ ids, onClose }: { ids: number[]; onClose: () => void }) {
	const [detailed, setDetailed] = useState(false);
	return detailed ? (
		<SyncSteps ids={ids} onClose={onClose} />
	) : (
		<SyncSummary ids={ids} onReviewSteps={() => setDetailed(true)} onClose={onClose} />
	);
}

/** Pull first (it changes the library), then review the push against the updated library. */
function SyncSteps({ ids, onClose }: { ids: number[]; onClose: () => void }) {
	const [pulled, setPulled] = useState(false);
	if (!pulled) {
		return (
			<div className="space-y-4">
				<p className="text-muted-foreground text-xs">Step 1 of 2: pull. Step 2 reviews the push.</p>
				<PullSteps ids={ids} onDone={() => setPulled(true)} />
			</div>
		);
	}
	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-xs">Step 2 of 2: push.</p>
			<ReviewBody ids={ids} onClose={onClose} />
		</div>
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
			title="See what will be sent, renamed or deleted before anything changes."
			onClick={() => start("push", ids)}
		>
			<CloudUpload /> {label}
		</Button>
	);
}

/**
 * The slide-overs for the pull, push and sync reviews. Mounted once beside the page, so any
 * button (the sidebar's included) can open them.
 */
export function SyncDrawers() {
	const { request, close } = useSyncActions();
	const all = useIds(request?.ids);
	const open = (kind: SyncKind) => request?.kind === kind;
	return (
		<>
			<Drawer open={open("pull")} onClose={close} title="Review pull" width="w-[44rem]">
				{request && <PullSteps key={request.session} ids={all} onDone={close} />}
			</Drawer>
			<Drawer open={open("push")} onClose={close} title="Review push" width="w-[44rem]">
				{request && <ReviewBody key={request.session} ids={request.ids} onClose={close} />}
			</Drawer>
			<Drawer open={open("sync")} onClose={close} title="Sync" width="w-[44rem]">
				{request && <SyncFlow key={request.session} ids={all} onClose={close} />}
			</Drawer>
		</>
	);
}
