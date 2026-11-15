import { type ReactNode, useCallback, useMemo, useState } from "react";
import { type DetailApi, DetailContext, type DetailView } from "#/context/detail-context.ts";
import { useUnsavedGuard } from "#/lib/unsaved.tsx";

function same(a: DetailView | undefined, b: DetailView): boolean {
	return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export function DetailProvider({ children }: { children: ReactNode }) {
	const [stack, setStack] = useState<readonly DetailView[]>([]);
	// Leaving the current view (closing, going back, opening another) first saves what it has
	// pending, and asks when that is not possible.
	const { guard, dialog, Provider } = useUnsavedGuard();

	const open = useCallback((view: DetailView) => void guard(() => setStack([view])), [guard]);
	const push = useCallback(
		(view: DetailView) =>
			void guard(() => setStack((s) => (same(s.at(-1), view) ? s : [...s, view]))),
		[guard],
	);
	const replace = useCallback(
		(view: DetailView) => void guard(() => setStack((s) => [...s.slice(0, -1), view])),
		[guard],
	);
	const back = useCallback(() => void guard(() => setStack((s) => s.slice(0, -1))), [guard]);
	const close = useCallback(() => void guard(() => setStack([])), [guard]);

	const value = useMemo<DetailApi>(
		() => ({
			view: stack.at(-1) ?? null,
			canGoBack: stack.length > 1,
			open,
			push,
			replace,
			back,
			close,
			UnsavedScope: Provider,
		}),
		[stack, open, push, replace, back, close, Provider],
	);
	return (
		<DetailContext.Provider value={value}>
			{children}
			{dialog}
		</DetailContext.Provider>
	);
}
