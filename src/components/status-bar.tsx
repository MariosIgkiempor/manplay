import { useMutationState } from "@tanstack/react-query";
import { CircleAlert, Undo2 } from "lucide-react";
import { type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnalysisStatusPill } from "#/components/analysis-status-pill.tsx";
import { SyncStatusPill } from "#/components/sync-status-pill.tsx";
import { StatusSlotContext, useDetail } from "#/context/detail-context.ts";
import {
	ActiveStatusContext,
	type StatusScope,
	StatusScopeContext,
} from "#/context/status-context.ts";
import { useUndo } from "#/context/undo-context.ts";
import { keyLabel } from "#/lib/platform.ts";
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
 * Puts a view's figures in the window's status bar, while the area it is in (the page or the side
 * panel) is the one last clicked or focused.
 */
export function StatusBar({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
	const slot = useContext(StatusSlotContext);
	const scope = useContext(StatusScopeContext);
	const { active } = useContext(ActiveStatusContext);
	if (!slot || scope !== active) {
		return null;
	}
	return createPortal(
		<>
			{leading}
			{children}
		</>,
		slot,
	);
}

/** The last action as a pill that undoes it (also ⌘Z). */
function UndoPill() {
	const { canUndo, label, undo } = useUndo();
	if (!canUndo || label === null) {
		return null;
	}
	return (
		<button
			type="button"
			onClick={() => void undo()}
			title={`Undo ${label} (${keyLabel("⌘Z")})`}
			className="flex min-w-0 shrink items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-foreground outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5 [&_svg]:shrink-0"
		>
			<Undo2 />
			<span className="truncate">Undo {label}</span>
			<kbd className="font-sans text-muted-foreground">{keyLabel("⌘Z")}</kbd>
		</button>
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
 * The window's status bar. Left: undo, errors and notices. Middle: sync and analysis progress.
 * Right: whether edits are saved, and the figures of the area last used.
 */
export function StatusBarHost({
	notices,
	setSlot,
	setSaveSlot,
}: {
	notices: ReactNode;
	setSlot: (el: HTMLElement | null) => void;
	setSaveSlot: (el: HTMLElement | null) => void;
}) {
	return (
		<footer className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 overflow-hidden whitespace-nowrap border-t bg-card/40 px-4 text-muted-foreground text-xs">
			<div className="flex min-w-0 items-center gap-4">
				<UndoPill />
				<StatusErrors />
				{notices}
			</div>
			<div className="flex items-center justify-center gap-4">
				<SyncStatusPill />
				<AnalysisStatusPill />
			</div>
			<div className="flex min-w-0 items-center justify-end gap-4">
				<div ref={setSaveSlot} className="flex min-w-0 items-center gap-3 empty:hidden" />
				<div ref={setSlot} className="flex min-w-0 items-center justify-end gap-4" />
			</div>
		</footer>
	);
}

/**
 * Tracks which area (page or side panel) is in use, for the status bar. Opening the panel makes it
 * the one in use; closing it hands back to the page.
 */
export function StatusScopeProvider({ children }: { children: ReactNode }) {
	const detail = useDetail();
	const [chosen, setActive] = useState<StatusScope>("main");
	const panelKey = detail.view ? JSON.stringify(detail.view) : null;
	useEffect(() => {
		if (panelKey !== null) {
			setActive("panel");
		}
	}, [panelKey]);
	const active = chosen === "panel" && panelKey === null ? "main" : chosen;
	const value = useMemo(() => ({ active, setActive }), [active]);
	return <ActiveStatusContext.Provider value={value}>{children}</ActiveStatusContext.Provider>;
}
