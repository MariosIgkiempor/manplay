import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
	type DetailApi,
	DetailContext,
	type DetailView,
	type DrawerView,
	isSplitView,
	type SplitView,
} from "#/context/detail-context.ts";
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
	const drawer = usePane<DrawerView>();
	const split = usePane<SplitView>();

	const open = useCallback(
		(view: DetailView) => (isSplitView(view) ? split.open(view) : drawer.open(view)),
		[split.open, drawer.open],
	);
	const push = useCallback(
		(view: DetailView) => (isSplitView(view) ? split.push(view) : drawer.push(view)),
		[split.push, drawer.push],
	);
	const replace = useCallback(
		(view: DetailView) => (isSplitView(view) ? split.replace(view) : drawer.replace(view)),
		[split.replace, drawer.replace],
	);

	const value = useMemo<DetailApi>(
		() => ({
			view: drawer.stack.at(-1) ?? null,
			canGoBack: drawer.stack.length > 1,
			back: drawer.back,
			close: drawer.close,
			UnsavedScope: drawer.Provider,
			split: {
				view: split.stack.at(-1) ?? null,
				canGoBack: split.stack.length > 1,
				back: split.back,
				close: split.close,
				UnsavedScope: split.Provider,
			},
			open,
			push,
			replace,
		}),
		[drawer, split, open, push, replace],
	);
	return (
		<DetailContext.Provider value={value}>
			{children}
			{drawer.dialog}
			{split.dialog}
		</DetailContext.Provider>
	);
}
