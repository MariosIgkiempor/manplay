import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

// Geometry of the collapsing header, in px. The header is as tall as FULL; once it has scrolled
// COLLAPSE px it sticks and only its bottom ROW px (controls + search) stay visible.
const PAD = 24;
const TITLE_BLOCK = 52;
const GAP = 12;
const ROW = 32;
const FULL = PAD + TITLE_BLOCK + GAP + ROW + GAP;
const COLLAPSE = PAD + TITLE_BLOCK;
const CONTROLS_TOP = PAD + (TITLE_BLOCK - ROW) / 2;
const ROW_TOP = PAD + TITLE_BLOCK + GAP;

function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const { overflowY } = getComputedStyle(p);
		if (overflowY === "auto" || overflowY === "scroll") {
			return p;
		}
	}
	return null;
}

/**
 * Writes `--p` (0 at the top, 1 once collapsed) and `--cw` (width of the right-hand controls)
 * straight onto the header element, so scrolling never re-renders React.
 */
function useCollapseProgress(
	header: React.RefObject<HTMLElement | null>,
	controls: React.RefObject<HTMLElement | null>,
) {
	useEffect(() => {
		const el = header.current;
		const scroller = el && scrollParent(el);
		if (!el || !scroller) {
			return;
		}
		const update = () => {
			const p = Math.min(1, Math.max(0, scroller.scrollTop / COLLAPSE));
			el.style.setProperty("--p", String(p));
		};
		update();
		scroller.addEventListener("scroll", update, { passive: true });
		const measure = new ResizeObserver(() => {
			el.style.setProperty("--cw", `${controls.current?.offsetWidth ?? 0}px`);
		});
		if (controls.current) {
			measure.observe(controls.current);
		}
		return () => {
			scroller.removeEventListener("scroll", update);
			measure.disconnect();
		};
	}, [header, controls]);
}

interface Props {
	title: string;
	subtitle?: string | undefined;
	/** Right-hand buttons. */
	controls: ReactNode;
	/** Search row. Without it the header is a plain static bar. */
	filters?: ReactNode;
}

/**
 * Page header that sticks to the top while scrolling: the title and subtitle scroll away and
 * fade out, and the search row slides up into their place beside the controls.
 */
export function LibraryHeader({ title, subtitle, controls, filters }: Props) {
	const heading = <Heading title={title} subtitle={subtitle} />;
	if (!filters) {
		return (
			<header className="flex flex-wrap items-center justify-between gap-3 p-6 pb-4">
				{heading}
				<div className="flex items-center gap-2">{controls}</div>
			</header>
		);
	}
	return (
		<StickyHeader heading={heading} controls={controls}>
			{filters}
		</StickyHeader>
	);
}

function Heading({ title, subtitle }: { title: string; subtitle?: string | undefined }) {
	return (
		<div className="min-w-0">
			<h1 className="font-bold text-2xl">{title}</h1>
			{subtitle && (
				<p className="truncate text-muted-foreground text-xs" title={subtitle}>
					{subtitle}
				</p>
			)}
		</div>
	);
}

function StickyHeader({
	heading,
	controls,
	children,
}: {
	heading: ReactNode;
	controls: ReactNode;
	children: ReactNode;
}) {
	const header = useRef<HTMLElement>(null);
	const controlsRef = useRef<HTMLDivElement>(null);
	useCollapseProgress(header, controlsRef);

	const vars = { "--p": 0, "--cw": "0px", top: -COLLAPSE, height: FULL } as CSSProperties;
	return (
		<header ref={header} className="sticky z-10 bg-background/90 backdrop-blur" style={vars}>
			<div
				className="absolute left-6 min-w-0"
				style={{
					top: PAD,
					right: `calc(${PAD}px + var(--cw) + ${GAP}px)`,
					opacity: "calc(1 - var(--p) * 1.6)",
				}}
			>
				{heading}
			</div>
			<div
				ref={controlsRef}
				className="absolute right-6 flex items-center gap-2"
				style={{
					top: CONTROLS_TOP,
					transform: `translateY(calc(var(--p) * ${ROW_TOP - CONTROLS_TOP}px))`,
				}}
			>
				{controls}
			</div>
			<div
				className="absolute left-6 flex items-center gap-2"
				style={{
					top: ROW_TOP,
					right: `calc(${PAD}px + (var(--cw) + ${GAP}px) * var(--p))`,
				}}
			>
				{children}
			</div>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border"
				style={{ opacity: "var(--p)" }}
			/>
		</header>
	);
}
