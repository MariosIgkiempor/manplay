import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type DetailApi, DetailContext, type DetailView } from "#/context/detail-context.ts";
import { useUnsavedGuard } from "#/lib/unsaved.tsx";

function same(a: DetailView | undefined, b: DetailView): boolean {
	return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** A stack of views, with every way out of the current one guarded by its unsaved changes. */
function usePane<V extends DetailView>() {
	const [stack, setStack] = useState<readonly V[]>([]);
	// Leaving the current view (closing, going back, opening another) first saves what it has
	// pending, and asks when that is not possible.
	const { guard, dialog, Provider } = useUnsavedGuard();
	const open = useCallback((view: V) => void guard(() => setStack([view])), [guard]);
	const push = useCallback(
		(view: V) => void guard(() => setStack((s) => (same(s.at(-1), view) ? s : [...s, view]))),
		[guard],
	);
	const replace = useCallback(
		(view: V) => void guard(() => setStack((s) => [...s.slice(0, -1), view])),
		[guard],
	);
	const back = useCallback(() => void guard(() => setStack((s) => s.slice(0, -1))), [guard]);
	const close = useCallback(() => void guard(() => setStack([])), [guard]);
	return { stack, open, push, replace, back, close, dialog, Provider };
}

export function DetailProvider({ children }: { children: ReactNode }) {
	const pane = usePane<DetailView>();
	const { stack } = pane;
	const [last, setLast] = useState<DetailView | null>(null);
	const top = stack.at(-1);
	useEffect(() => {
		if (top !== undefined) {
			setLast(top);
		}
	}, [top]);
	const value = useMemo<DetailApi>(
		() => ({
			view: top ?? null,
			last,
			canGoBack: stack.length > 1,
			back: pane.back,
			close: pane.close,
			UnsavedScope: pane.Provider,
			open: pane.open,
			push: pane.push,
			replace: pane.replace,
		}),
		[pane, stack, top, last],
	);
	return (
		<DetailContext.Provider value={value}>
			{children}
			{pane.dialog}
		</DetailContext.Provider>
	);
}
