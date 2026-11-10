import { type ReactNode, useCallback, useMemo, useState } from "react";
import { type DetailApi, DetailContext, type DetailView } from "#/context/detail-context.ts";

function same(a: DetailView | undefined, b: DetailView): boolean {
	return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export function DetailProvider({ children }: { children: ReactNode }) {
	const [stack, setStack] = useState<readonly DetailView[]>([]);

	const open = useCallback((view: DetailView) => setStack([view]), []);
	const push = useCallback(
		(view: DetailView) => setStack((s) => (same(s.at(-1), view) ? s : [...s, view])),
		[],
	);
	const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
	const close = useCallback(() => setStack([]), []);

	const value = useMemo<DetailApi>(
		() => ({ view: stack.at(-1) ?? null, canGoBack: stack.length > 1, open, push, back, close }),
		[stack, open, push, back, close],
	);
	return <DetailContext.Provider value={value}>{children}</DetailContext.Provider>;
}
