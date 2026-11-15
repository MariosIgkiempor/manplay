import { useMutationState } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { AnalysisStatusPill } from "#/components/analysis-status-pill.tsx";
import { SyncStatusPill } from "#/components/sync-status-pill.tsx";
import { PanelScopeContext, StatusSlotContext } from "#/context/detail-context.ts";
import { SCAN_KEY, SYNC_KEY } from "#/lib/queries.ts";

/** A labelled value in a status bar. */
export function Stat({ label, value }: { label: string; value: number | string }) {
	return (
		<span>
			{label}: <span className="text-foreground">{value}</span>
		</span>
	);
}

/**
 * Puts a view's figures in the status bar. On a page they go into the app's always-visible bar
 * (after sync progress and the missing-files notice); inside the slide-over they pin to the
 * panel's bottom edge, with content scrolling behind them.
 */
export function StatusBar({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
	const slot = useContext(StatusSlotContext);
	const inPanel = useContext(PanelScopeContext);
	if (!slot) {
		return null;
	}
	if (!inPanel) {
		return createPortal(
			<>
				{leading}
				{children}
			</>,
			slot,
		);
	}
	return (
		<>
			<div aria-hidden="true" className="h-9" />
			{createPortal(
				<div className="flex items-center gap-4 border-t bg-background/70 px-4 py-2 text-muted-foreground text-xs backdrop-blur-md">
					{leading}
					<div className="ml-auto flex items-center gap-4">{children}</div>
				</div>,
				slot,
			)}
		</>
	);
}

/** Error of the latest run of a mutation, or `null` when that run did not fail. */
function useLatestError(key: readonly string[]): string | null {
	const last = useMutationState({
		filters: { mutationKey: key },
		select: (m) => ({ status: m.state.status, error: String(m.state.error) }),
	}).at(-1);
	return last?.status === "error" ? last.error : null;
}

/** Scan and sync failures, so they show on every page. */
function StatusErrors() {
	const errors = [useLatestError(SCAN_KEY), useLatestError(SYNC_KEY)].filter(
		(e): e is string => e !== null,
	);
	return errors.map((e) => (
		<span key={e} className="flex min-w-0 items-center gap-1.5 text-destructive" title={e}>
			<CircleAlert className="size-3.5 shrink-0" />
			<span className="truncate">{e}</span>
		</span>
	));
}

/**
 * The app's status bar. Left: errors and notices. Middle: sync and analysis progress. Right: the current
 * view's figures.
 */
export function StatusBarHost({
	notices,
	setSlot,
}: {
	notices: ReactNode;
	setSlot: (el: HTMLElement | null) => void;
}) {
	return (
		<footer className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-t bg-card/40 px-4 text-muted-foreground text-xs">
			<div className="flex min-w-0 items-center gap-4">
				<StatusErrors />
				{notices}
			</div>
			<div className="flex items-center justify-center gap-4">
				<SyncStatusPill />
				<AnalysisStatusPill />
			</div>
			<div ref={setSlot} className="flex items-center justify-end gap-4" />
		</footer>
	);
}
