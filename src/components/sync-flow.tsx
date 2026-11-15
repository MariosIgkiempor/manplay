import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { PullReview } from "#/components/pull-review.tsx";
import { ReviewBody } from "#/components/sync-review.tsx";
import { Button } from "#/components/ui/button.tsx";
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
	const [open, setOpen] = useState(false);
	const [session, setSession] = useState(0);
	return (
		<>
			<Button
				size={size}
				variant={variant}
				disabled={disabled === true || all.length === 0}
				title="Copy songs your library is missing from destinations. A pull never deletes."
				onClick={() => {
					setSession((n) => n + 1);
					setOpen(true);
				}}
			>
				<Download /> Review pull
			</Button>
			<Drawer open={open} onClose={() => setOpen(false)} title="Review pull" width="w-[44rem]">
				{open && <PullSteps key={session} ids={all} onDone={() => setOpen(false)} />}
			</Drawer>
		</>
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
export function SyncButton({ ids, size, variant, disabled }: Props) {
	const all = useIds(ids);
	const [open, setOpen] = useState(false);
	const [session, setSession] = useState(0);
	return (
		<>
			<Button
				size={size}
				variant={variant}
				disabled={disabled === true || all.length === 0}
				title="Pull, then push. You review each step before anything changes."
				onClick={() => {
					setSession((n) => n + 1);
					setOpen(true);
				}}
			>
				<RefreshCw /> Sync
			</Button>
			<Drawer open={open} onClose={() => setOpen(false)} title="Review sync" width="w-[44rem]">
				{open && <SyncSteps key={session} ids={all} onClose={() => setOpen(false)} />}
			</Drawer>
		</>
	);
}
