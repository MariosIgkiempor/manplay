import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
	type DetailApi,
	DetailContext,
	type DetailOrigin,
	type DetailView,
} from "#/context/detail-context.ts";
import { currentActionOrigin } from "#/lib/action-anchor.ts";
import { useUnsavedGuard } from "#/lib/unsaved.tsx";

function same(a: DetailView | undefined, b: DetailView): boolean {
	return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

const NO_ORIGIN: DetailOrigin = { element: null, box: null };

/** What the action happening now started from: where a card opened by it grows out of. */
function originNow(): DetailOrigin {
	const origin = currentActionOrigin();
	return origin ? { element: origin.element, box: origin.box } : NO_ORIGIN;
}

/** The views on show, newest last, and how they show. */
interface Shown<V> {
	stack: readonly V[];
	pinned: boolean;
	origin: DetailOrigin;
	opened: number;
}

/** A stack of views, with every way out of the current one guarded by its unsaved changes. */
function usePane<V extends DetailView>() {
	const [shown, setShown] = useState<Shown<V>>({
		stack: [],
		pinned: false,
		origin: NO_ORIGIN,
		opened: 0,
	});
	// Leaving the current view (closing, going back, opening another) first saves what it has
	// pending, and asks when that is not possible.
	const { guard, dialog, Provider } = useUnsavedGuard();
	const open = useCallback(
		(view: V) => {
			// Read now: by the time unsaved changes are saved, the press is long over.
			const origin = originNow();
			void guard(() =>
				setShown((s) =>
					s.pinned && s.stack.length > 0
						? { ...s, stack: [view] }
						: { stack: [view], pinned: false, origin, opened: s.opened + 1 },
				),
			);
		},
		[guard],
	);
	const openPinned = useCallback(
		(view: V) => void guard(() => setShown((s) => ({ ...s, stack: [view], pinned: true }))),
		[guard],
	);
	const pin = useCallback(() => setShown((s) => ({ ...s, pinned: true })), []);
	const push = useCallback(
		(view: V) =>
			void guard(() =>
				setShown((s) => (same(s.stack.at(-1), view) ? s : { ...s, stack: [...s.stack, view] })),
			),
		[guard],
	);
	const replace = useCallback(
		(view: V) =>
			void guard(() => setShown((s) => ({ ...s, stack: [...s.stack.slice(0, -1), view] }))),
		[guard],
	);
	const back = useCallback(
		() => void guard(() => setShown((s) => ({ ...s, stack: s.stack.slice(0, -1) }))),
		[guard],
	);
	const close = useCallback(
		() => void guard(() => setShown((s) => ({ ...s, stack: [], pinned: false }))),
		[guard],
	);
	return { shown, open, openPinned, pin, push, replace, back, close, dialog, Provider };
}

export function DetailProvider({ children }: { children: ReactNode }) {
	const pane = usePane<DetailView>();
	const { shown } = pane;
	const [last, setLast] = useState<DetailView | null>(null);
	const top = shown.stack.at(-1);
	useEffect(() => {
		if (top !== undefined) {
			setLast(top);
		}
	}, [top]);
	const value = useMemo<DetailApi>(
		() => ({
			view: top ?? null,
			pinned: shown.pinned,
			origin: shown.origin,
			opened: shown.opened,
			pin: pane.pin,
			openPinned: pane.openPinned,
			last,
			canGoBack: shown.stack.length > 1,
			back: pane.back,
			close: pane.close,
			UnsavedScope: pane.Provider,
			open: pane.open,
			push: pane.push,
			replace: pane.replace,
		}),
		[pane, shown, top, last],
	);
	return (
		<DetailContext.Provider value={value}>
			{children}
			{pane.dialog}
		</DetailContext.Provider>
	);
}
