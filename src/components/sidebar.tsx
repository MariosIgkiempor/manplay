import { Link, useRouterState } from "@tanstack/react-router";
import {
	Database,
	Download,
	FolderTree,
	Library,
	Music,
	PanelLeftClose,
	PanelLeftOpen,
	Settings,
	Upload,
} from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { ResizeHandle } from "#/components/resize-handle.tsx";
import { SidebarRecentlyDeleted } from "#/components/sidebar-deleted.tsx";
import { SidebarHighlight } from "#/components/sidebar-highlight.tsx";
import { RowCount, SectionLabel } from "#/components/sidebar-parts.tsx";
import { SidebarPlaylists } from "#/components/sidebar-playlists.tsx";
import { currentRow, rowActive } from "#/components/sidebar-row.ts";
import { SidebarSmartPlaylists } from "#/components/sidebar-smart-playlists.tsx";
import { SidebarSync } from "#/components/sidebar-sync.tsx";
import { SidebarTagTree } from "#/components/sidebar-tag-tree.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { directionTo, markDirection } from "#/lib/page-transition.ts";
import { useKeyLabel } from "#/lib/platform.ts";
import { useClashes, useTracks } from "#/lib/queries.ts";
import { useUpdateCheck } from "#/lib/updater.ts";
import { usePaneWidth, useStoredFlag } from "#/lib/use-pane-width.ts";
import { cn } from "#/lib/utils.ts";

const INITIAL = 240;
const MIN = 200;
const MAX = 400;
/** Dragging the edge this far in folds the sidebar away. */
const FOLD_AT = 140;

/** True while the sidebar shows icons only. */
const CollapsedContext = createContext(false);

// The right padding matches a list row's trailing slot, so badges line up with the counts.
const linkClass =
	"relative flex items-center gap-2 truncate rounded-md py-1.5 pr-2 pl-5 text-sm text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground";
const railLinkClass =
	"relative grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground";
const activeProps = { className: rowActive } as const;

function NavLink({
	label,
	icon,
	badge,
	count,
	...props
}: {
	to: "/" | "/files" | "/import" | "/export" | "/metadata" | "/settings";
	label: string;
	icon: ReactNode;
	/** A dot or pill at the end of the row (on the icon when collapsed). */
	badge?: ReactNode;
	/** How many it holds, at the end of the row like every sidebar count; hidden when collapsed. */
	count?: number | undefined;
}) {
	const collapsed = useContext(CollapsedContext);
	return (
		<Link
			{...props}
			title={collapsed ? label : undefined}
			aria-label={collapsed ? label : undefined}
			className={collapsed ? railLinkClass : linkClass}
			activeOptions={{ exact: true }}
			activeProps={activeProps}
		>
			<span className="[&_svg]:size-4">{icon}</span>
			{collapsed ? (
				badge && (
					<span
						className="absolute top-1 right-1 size-2 rounded-full bg-primary"
						aria-hidden="true"
					/>
				)
			) : (
				<>
					{label}
					{badge}
					{count !== undefined && count > 0 && <RowCount n={count} />}
				</>
			)}
		</Link>
	);
}

/** Folded away, Import and Export are plain icons; otherwise they live in the Sync section. */
function RailSyncLinks({ syncing }: { syncing: boolean }) {
	const clashes = (useClashes().data?.length ?? 0) > 0;
	return (
		<>
			<NavLink to="/import" label="Import" icon={<Download />} />
			<NavLink
				to="/export"
				label="Export"
				icon={<Upload />}
				badge={
					syncing ? (
						<span className="ml-auto size-2 animate-pulse rounded-full bg-primary" />
					) : (
						clashes && <span className="ml-auto size-2 rounded-full bg-warning" />
					)
				}
			/>
		</>
	);
}

/** ⌘\ folds the sidebar away and back. */
function useToggleKey(toggle: () => void) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
				e.preventDefault();
				toggle();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggle]);
}

/** The current row, scrolled into view whenever the page changes. */
function useCurrentRowInView(aside: React.RefObject<HTMLElement | null>) {
	const href = useRouterState({ select: (s) => s.location.href });
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs again each time the page changes
	useEffect(() => {
		const row = aside.current ? currentRow(aside.current) : null;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		row?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
	}, [aside, href]);
}

/**
 * Folding to the icon rail and back glides the sidebar's width, so the page beside it widens and
 * narrows smoothly. Call the returned `arm` just before folding; launching folded, or dragging the
 * edge, does not glide.
 */
function useFoldGlide(aside: React.RefObject<HTMLElement | null>): () => void {
	const from = useRef<number | null>(null);
	// Runs after every render, and acts only on the one that follows `arm`.
	useLayoutEffect(() => {
		const el = aside.current;
		const start = from.current;
		from.current = null;
		if (!el || start === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			return;
		}
		const end = el.getBoundingClientRect().width;
		el.style.overflow = "hidden";
		const motion = el.animate([{ width: `${start}px` }, { width: `${end}px` }], {
			duration: 240,
			easing: "cubic-bezier(0.3, 0, 0.2, 1)",
		});
		motion.onfinish = () => {
			el.style.overflow = "";
		};
	});
	return () => {
		from.current = aside.current?.getBoundingClientRect().width ?? null;
	};
}

/** Before a sidebar click navigates, notes which way the page should move for it. */
function noteDirection(aside: HTMLElement, clickY: number) {
	const current = currentRow(aside)?.getBoundingClientRect() ?? null;
	markDirection(directionTo(clickY, current));
}

/**
 * The app's left column: pages, sync, playlists and tags. Drag its edge to resize it; fold it to
 * an icon rail with the button at the top, by dragging it narrow, or with ⌘\.
 */
export function Sidebar() {
	const syncing = useSyncProgress().size > 0;
	const songCount = useTracks().data?.length;
	const updateAvailable = useUpdateCheck().data != null;
	const [width, setWidth] = usePaneWidth({
		key: "manplay.sidebar-width",
		initial: INITIAL,
		min: MIN,
		max: () => MAX,
	});
	const [collapsed, setStoredCollapsed] = useStoredFlag("manplay.sidebar-collapsed");
	const asideRef = useRef<HTMLElement>(null);
	const armGlide = useFoldGlide(asideRef);
	const setCollapsed = (next: boolean) => {
		armGlide();
		setStoredCollapsed(next);
	};
	const toggle = () => setCollapsed(!collapsed);
	useToggleKey(toggle);
	const shortcut = useKeyLabel("⌘\\");
	useCurrentRowInView(asideRef);

	const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
	const toggleButton = (
		<button
			type="button"
			onClick={toggle}
			aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
			title={`${collapsed ? "Expand" : "Collapse"} sidebar (${shortcut})`}
			className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4"
		>
			<ToggleIcon />
		</button>
	);

	return (
		<CollapsedContext.Provider value={collapsed}>
			<aside
				ref={asideRef}
				onClickCapture={(e) => noteDirection(e.currentTarget, e.clientY)}
				style={collapsed ? undefined : { width }}
				className={cn(
					"relative isolate flex shrink-0 flex-col gap-4 bg-canvas py-3",
					collapsed ? "w-14 items-center px-2" : "px-3",
				)}
			>
				<SidebarHighlight aside={asideRef} />
				{collapsed ? (
					toggleButton
				) : (
					<div className="flex items-center gap-2 pt-1 pl-2 font-semibold">
						<Music className="size-5 shrink-0 text-primary" />
						<span className="flex-1 truncate">manplay</span>
						{toggleButton}
					</div>
				)}
				<nav className={cn("space-y-0.5", collapsed && "flex flex-col items-center")}>
					<NavLink to="/" label="Library" icon={<Library />} count={songCount} />
					<NavLink to="/files" label="Files" icon={<FolderTree />} />
					<NavLink to="/metadata" label="Metadata" icon={<Database />} />
					{collapsed && <RailSyncLinks syncing={syncing} />}
				</nav>
				{collapsed ? (
					<div className="flex-1" />
				) : (
					<div data-sidebar-scroll className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
						<SidebarSync />
						<section className="mt-4 space-y-0.5">
							<SectionLabel>Organise</SectionLabel>
							<SidebarPlaylists />
							<SidebarSmartPlaylists />
							<SidebarTagTree />
							<SidebarRecentlyDeleted />
						</section>
					</div>
				)}
				<nav
					className={cn("border-hairline border-t pt-2", collapsed && "flex w-full justify-center")}
				>
					<NavLink
						to="/settings"
						label="Settings"
						icon={<Settings />}
						badge={
							updateAvailable && (
								<span className="ml-auto rounded-full bg-primary px-1.5 text-primary-foreground text-xs">
									Update
								</span>
							)
						}
					/>
				</nav>
				{!collapsed && (
					<ResizeHandle
						edge="right"
						width={width}
						min={MIN}
						initial={INITIAL}
						label="Resize sidebar"
						onWidth={(w) => {
							if (w < FOLD_AT) {
								// The handle goes away with the drag still held: put the cursor back.
								document.body.style.cursor = "";
								setCollapsed(true);
							} else {
								setWidth(w);
							}
						}}
					/>
				)}
			</aside>
		</CollapsedContext.Provider>
	);
}
