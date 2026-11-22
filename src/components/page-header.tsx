import { Check, ChevronRight, Pencil, Play, Trash2, X } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { HeaderMenu, type HeaderMenuEntry } from "#/components/header-menu.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ButtonGroup } from "#/components/ui/button-group.tsx";
import { Input } from "#/components/ui/input.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { PAGE_ART } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/** Four album covers in a grid, one cover when fewer albums exist, or `fallback` for none. */
export function Cover({
	tracks,
	fallback,
	className = "size-28",
}: {
	tracks: readonly Track[];
	fallback: ReactNode;
	className?: string;
}) {
	const covers = useMemo(() => groupAlbums(tracks).map((a) => a.coverTrackId), [tracks]);
	const frame = cn(
		"shrink-0 overflow-hidden rounded-lg shadow-md ring-1 ring-foreground/10",
		className,
	);
	if (covers.length >= 4) {
		return (
			<div className={cn(frame, "grid grid-cols-2 grid-rows-2")}>
				{covers.slice(0, 4).map((id) => (
					<AlbumArt key={id} trackId={id} className="size-full" />
				))}
			</div>
		);
	}
	if (covers.length > 0) {
		return <AlbumArt trackId={covers[0] ?? 0} className={frame} />;
	}
	return (
		<div className={cn(frame, "flex items-center justify-center bg-muted text-muted-foreground")}>
			{fallback}
		</div>
	);
}

/** The title, swapping for a text field while it is being renamed. */
function Title({
	title,
	editing,
	initial,
	onSubmit,
	onCancel,
}: {
	title: string;
	editing: boolean;
	initial: string;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState(initial);
	useEffect(() => {
		if (editing) {
			setText(initial);
		}
	}, [editing, initial]);
	if (!editing) {
		return (
			<h1 className="truncate font-semibold text-lg tracking-tight" data-hint={title}>
				{title}
			</h1>
		);
	}
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (text.trim() !== "") {
			onSubmit(text.trim());
		}
	};
	return (
		<form onSubmit={submit} className="flex items-center gap-1.5">
			<Input
				autoFocus
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => e.key === "Escape" && onCancel()}
				aria-label="Name"
				className="h-9 max-w-md font-semibold text-lg"
			/>
			<Button type="submit" size="icon" aria-label="Save name">
				<Check />
			</Button>
			<Button
				type="button"
				size="icon"
				variant="ghost"
				aria-label="Cancel rename"
				onClick={onCancel}
			>
				<X />
			</Button>
		</form>
	);
}

/** A plain title as the page's heading, with hover text; anything else as it is. */
function HeaderTitle({
	title,
	hint,
	size,
}: {
	title: ReactNode;
	hint: string | undefined;
	size: string;
}) {
	if (typeof title !== "string") {
		return title;
	}
	return (
		<h1 className={cn("truncate font-semibold tracking-tight", size)} data-hint={hint ?? title}>
			{title}
		</h1>
	);
}

const VARIANTS = {
	/** A full page: the band runs edge to edge under the page's own padding. */
	page: {
		band: "border-hairline border-b px-6 pt-5",
		bottom: "pb-4",
		gap: "gap-4",
		title: "text-xl",
		small: "text-sm",
	},
	/** A drawer or the split: the band bleeds over the panel's 1.25rem padding to its edges. */
	panel: {
		band: "-mx-5 -mt-5 border-hairline border-b px-5 pt-5",
		bottom: "pb-4",
		gap: "gap-4",
		title: "text-lg",
		small: "text-xs",
	},
	/** Inside other content: no band, same layout. */
	plain: { band: "", bottom: "", gap: "gap-5", title: "text-xl", small: "text-xs" },
} as const;

/**
 * The one header every page and panel has: cover or icon, what kind of thing it is, its title,
 * figures, and its buttons. Tabs, when there are some, sit on the header's bottom edge.
 */
/** Whether a slot was given something to show. */
const shows = (node: ReactNode) => node !== undefined && node !== null && node !== false;

/** What the page is (a crumb, an icon) on the left, a status or switch on the right. */
function KindLine({ kind, badge, size }: { kind: ReactNode; badge: ReactNode; size: string }) {
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-3 text-muted-foreground [&_svg]:size-3.5",
				size,
			)}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">{kind}</div>
			{badge}
		</div>
	);
}

/** The page's figures on their own line under the title. */
function MetaLine({ meta, size }: { meta: ReactNode; size: string }) {
	if (!shows(meta)) {
		return null;
	}
	return (
		<div
			className={cn(
				"flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-muted-foreground tabular-nums",
				size,
			)}
		>
			{meta}
		</div>
	);
}

/** The title, with the page's figures on the same baseline when they go there. */
function TitleLine({ title, meta }: { title: ReactNode; meta: ReactNode }) {
	if (!shows(meta)) {
		return <div className="min-w-0 flex-1 basis-40">{title}</div>;
	}
	return (
		<div className="flex min-w-0 flex-1 basis-40 items-baseline gap-3 [&>h1]:shrink-0">
			{title}
			<div className="flex min-w-0 items-baseline gap-3 truncate text-muted-foreground text-sm tabular-nums">
				{meta}
			</div>
		</div>
	);
}

export function PageHeader({
	art = null,
	kind,
	badge,
	title,
	titleHint,
	subtitle,
	meta,
	actions,
	children,
	tabs,
	variant = "page",
}: {
	/** A cover or brand at the start; app pages have none. */
	art?: ReactNode;
	/**
	 * Where this is, before the title: a crumb that moves between siblings, or a tag's parents.
	 * Words that only say what kind of page it is belong nowhere: the sidebar already says it.
	 */
	kind?: ReactNode;
	/** A status or switch at the top right, e.g. a source's on/off switch. */
	badge?: ReactNode;
	/** The title, or a field while it is being renamed. */
	title: ReactNode;
	/** Hover text for a plain title, e.g. where it is on disk. */
	titleHint?: string | undefined;
	/** A line under the title, e.g. the artist (panels only). */
	subtitle?: ReactNode;
	/** Figures beside the title: counts, sizes, how far along. */
	meta?: ReactNode;
	actions?: ReactNode;
	/** Extra content under the title line, such as subtags. */
	children?: ReactNode;
	/** Tabs along the bottom edge. */
	tabs?: ReactNode;
	variant?: keyof typeof VARIANTS;
}) {
	if (variant === "page") {
		return (
			<CompactHeader
				art={art}
				kind={kind}
				badge={badge}
				title={<HeaderTitle title={title} hint={titleHint} size="text-lg" />}
				meta={meta}
				actions={actions}
				tabs={tabs}
			>
				{children}
			</CompactHeader>
		);
	}
	const v = VARIANTS[variant];
	const hasTabs = shows(tabs);
	const hasTop = kind !== undefined || badge !== undefined;
	return (
		<header className={cn("shrink-0", v.band, hasTabs ? "pb-0" : v.bottom)}>
			{/* The title lines up with the top of the art; actions sit on the title's line, right. */}
			<div className={cn("flex items-start", v.gap, hasTabs && v.bottom)}>
				{art}
				<div className="min-w-0 flex-1 space-y-1">
					{hasTop && <KindLine kind={kind} badge={badge} size={v.small} />}
					{/* The buttons drop under the title once the two no longer fit side by side. */}
					<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
						<TitleLine
							title={<HeaderTitle title={title} hint={titleHint} size={v.title} />}
							meta={null}
						/>
						{actions && (
							<ButtonGroup size="sm" className="mt-0.5">
								{actions}
							</ButtonGroup>
						)}
					</div>
					{subtitle !== undefined && (
						<div className="truncate text-muted-foreground text-sm">{subtitle}</div>
					)}
					<MetaLine meta={meta} size={v.small} />
					{children && <div className="pt-2">{children}</div>}
				</div>
			</div>
			<div className="-mb-px empty:hidden">{tabs}</div>
		</header>
	);
}

/**
 * A full page's header, the same on every page (the Library's): one line with a small mark, the
 * title and its figures, and the buttons at the right; tabs under it. Scrolling the page takes the
 * title line away and keeps the tabs at the top, as the Library keeps its tabs and search.
 */
function CompactHeader({
	art,
	kind,
	badge,
	title,
	meta,
	actions,
	tabs,
	children,
}: {
	art: ReactNode;
	kind: ReactNode;
	badge: ReactNode;
	title: ReactNode;
	meta: ReactNode;
	actions: ReactNode;
	tabs: ReactNode;
	children: ReactNode;
}) {
	const ref = useRef<HTMLElement>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
	const [top, setTop] = useState(0);
	const hasTabs = shows(tabs);
	useLayoutEffect(() => {
		const header = ref.current;
		const page = header?.parentElement;
		if (!(header && page)) {
			return;
		}
		// Sticks with only its tabs showing: everything above them scrolls out of sight. What else
		// the page pins goes under the tabs (`--pinned-header`), within what is left of the page's
		// height (`--page-height`).
		const measure = () => {
			const pinned = hasTabs ? (tabsRef.current?.offsetHeight ?? 0) : 0;
			setTop(pinned - header.offsetHeight);
			page.style.setProperty("--pinned-header", `${pinned}px`);
			page.style.setProperty("--page-height", `${page.clientHeight}px`);
		};
		measure();
		const watch = new ResizeObserver(measure);
		watch.observe(header);
		watch.observe(page);
		return () => watch.disconnect();
	}, [hasTabs]);
	return (
		<header
			ref={ref}
			style={hasTabs ? { top } : undefined}
			className={cn(
				"z-10 shrink-0 border-hairline border-b bg-background px-6 pt-5",
				hasTabs ? "sticky pb-0" : "pb-4",
			)}
		>
			<div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
					{art}
					{shows(kind) && (
						<span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-sm [&_svg]:size-3.5">
							{kind}
							<ChevronRight aria-hidden="true" />
						</span>
					)}
					<div className="flex min-w-0 items-baseline gap-3 [&>h1]:shrink-0 [&>h1]:truncate">
						{title}
						{shows(meta) && (
							<div className="flex min-w-0 items-center gap-3 truncate text-muted-foreground text-sm tabular-nums">
								{meta}
							</div>
						)}
					</div>
				</div>
				{(shows(badge) || shows(actions)) && (
					<div className="flex shrink-0 items-center gap-2">
						{badge}
						{shows(actions) && <ButtonGroup>{actions}</ButtonGroup>}
					</div>
				)}
			</div>
			{shows(children) && <div className="pt-3">{children}</div>}
			{hasTabs && (
				<div ref={tabsRef} className="-mb-px mt-3">
					{tabs}
				</div>
			)}
		</header>
	);
}

interface CollectionProps {
	/** Where this is, e.g. a tag's parents; none for a playlist. */
	kind?: ReactNode;
	title: string;
	/** Text the rename field starts with; defaults to the title. */
	renameFrom?: string;
	meta: ReactNode;
	tracks: readonly Track[];
	/** Shown in place of the cover while no song has artwork. */
	fallbackIcon: ReactNode;
	onRename: (name: string) => void;
	onDelete: () => void;
	/** Shared / Private switch at the top right (shown while in a shared library). */
	sharing?: ReactNode;
	/** More ⋯ rows, between Rename and Delete. */
	menuExtra?: readonly HeaderMenuEntry[];
	/** Extra content under the buttons, such as subtags. */
	children?: ReactNode;
	/** How the songs are sorted (a `SortMenu` as a segment), before Play. */
	sort?: ReactNode;
}

/** Header of a playlist or tag page: covers, name, figures, Play, and Rename / Delete under ⋯. */
export function CollectionHeader({
	kind,
	title,
	renameFrom,
	meta,
	tracks,
	fallbackIcon,
	onRename,
	onDelete,
	sharing,
	menuExtra = [],
	children,
	sort,
}: CollectionProps) {
	const player = usePlayer();
	const [editing, setEditing] = useState(false);
	return (
		<PageHeader
			art={<Cover tracks={tracks} fallback={fallbackIcon} className={PAGE_ART} />}
			kind={kind}
			title={
				<Title
					title={title}
					editing={editing}
					initial={renameFrom ?? title}
					onSubmit={(name) => {
						setEditing(false);
						onRename(name);
					}}
					onCancel={() => setEditing(false)}
				/>
			}
			badge={sharing}
			meta={meta}
			actions={
				<>
					{sort}
					<Button disabled={tracks.length === 0} onClick={() => player.play(tracks, 0)}>
						<Play /> Play
					</Button>
					<HeaderMenu
						entries={[
							{
								label: "Rename",
								icon: <Pencil />,
								onSelect: () => setEditing(true),
								disabled: editing,
							},
							"separator",
							...menuExtra,
							"separator",
							{ label: "Delete…", icon: <Trash2 />, onSelect: onDelete, destructive: true },
						]}
					/>
				</>
			}
		>
			{children}
		</PageHeader>
	);
}
