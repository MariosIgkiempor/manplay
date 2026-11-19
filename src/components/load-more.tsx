import { useEffect, useRef } from "react";

/**
 * Put after a progressively shown list: asks for the next page once it comes within a screen of
 * view, so scrolling never reaches an end that isn't the real one.
 */
export function LoadMore({ more, onMore }: { more: boolean; onMore: () => void }) {
	const sentinel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = sentinel.current;
		if (!(el && more)) {
			return;
		}
		const seen = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					onMore();
				}
			},
			{ rootMargin: "100% 0px" },
		);
		seen.observe(el);
		return () => seen.disconnect();
	}, [more, onMore]);
	return more ? <div ref={sentinel} aria-hidden="true" className="h-px" /> : null;
}
