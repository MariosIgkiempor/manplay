import { Check, Pencil, Play, Trash2, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ButtonGroup } from "#/components/ui/button-group.tsx";
import { Input } from "#/components/ui/input.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
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
		"shrink-0 overflow-hidden rounded-lg shadow-lg ring-1 ring-foreground/10",
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
			<h1 className="truncate font-semibold text-3xl tracking-tight" title={title}>
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
				className="h-10 max-w-md font-semibold text-2xl"
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

/** The square that heads a page without covers of its own: the page's icon on a tile. */
export function PageIcon({ children }: { children: ReactNode }) {
	return (
		<div className="grid size-28 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground shadow-lg ring-1 ring-foreground/10 [&_svg]:size-10">
			{children}
		</div>
	);
}

const VARIANTS = {
	/** A full page: the band runs edge to edge under the page's own padding. */
	page: {
		band: "border-b bg-card/40 px-6 pt-8",
		bottom: "pb-6",
		gap: "gap-6",
		title: "text-3xl",
		small: "text-sm",
	},
	/** A drawer or the split: the band bleeds over the panel's 1.25rem padding to its edges. */
	panel: {
		band: "-mx-5 -mt-5 border-b bg-card/40 px-5 pt-6",
		bottom: "pb-5",
		gap: "gap-5",
		title: "text-2xl",
		small: "text-xs",
	},
	/** Inside other content: no band, same layout. */
	plain: { band: "", bottom: "", gap: "gap-5", title: "text-xl", small: "text-xs" },
} as const;

/**
 * The one header every page and panel has: cover or icon, what kind of thing it is, its title,
 * figures, and its buttons. Tabs, when there are some, sit on the header's bottom edge.
 */
export function PageHeader({
	art,
	kind,
	badge,
	title,
	subtitle,
	meta,
	actions,
	children,
	tabs,
	variant = "page",
}: {
	art: ReactNode;
	/** What this is, e.g. "Playlist" or a tag breadcrumb, with an icon. App pages have none. */
	kind?: ReactNode;
	/** A status or switch at the top right, e.g. "Synced" or a source's on/off switch. */
	badge?: ReactNode;
	/** The title, or a field while it is being renamed. */
	title: ReactNode;
	/** A line under the title, e.g. the artist. */
	subtitle?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
	/** Extra content under the buttons, such as subtags. */
	children?: ReactNode;
	/** Tabs along the bottom edge. */
	tabs?: ReactNode;
	variant?: keyof typeof VARIANTS;
}) {
	const v = VARIANTS[variant];
	const hasTabs = tabs !== undefined && tabs !== null && tabs !== false;
	const hasTop = kind !== undefined || badge !== undefined;
	return (
		<header className={cn("shrink-0", v.band, hasTabs ? "pb-0" : v.bottom)}>
			{/* The title lines up with the top of the art; actions sit on the title's line, right. */}
			<div className={cn("flex items-start", v.gap, hasTabs && v.bottom)}>
				{art}
				<div className="min-w-0 flex-1 space-y-1">
					{hasTop && (
						<div
							className={cn(
								"flex items-center justify-between gap-3 text-muted-foreground [&_svg]:size-3.5",
								v.small,
							)}
						>
							<div className="flex min-w-0 flex-wrap items-center gap-1.5">{kind}</div>
							{badge}
						</div>
					)}
					{/* The buttons drop under the title once the two no longer fit side by side. */}
					<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
						<div className="min-w-0 flex-1 basis-40">
							{typeof title === "string" ? (
								<h1 className={cn("truncate font-semibold tracking-tight", v.title)} title={title}>
									{title}
								</h1>
							) : (
								title
							)}
						</div>
						{actions && (
							<ButtonGroup size={variant === "page" ? "default" : "sm"} className="mt-0.5">
								{actions}
							</ButtonGroup>
						)}
					</div>
					{subtitle !== undefined && (
						<div className="truncate text-muted-foreground text-sm">{subtitle}</div>
					)}
					{meta && (
						<div
							className={cn(
								"flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-muted-foreground tabular-nums",
								v.small,
							)}
						>
							{meta}
						</div>
					)}
					{children && <div className="pt-2">{children}</div>}
				</div>
			</div>
			{hasTabs && <div className="-mb-px">{tabs}</div>}
		</header>
	);
}

interface CollectionProps {
	/** What this page is, e.g. "Playlist" or a tag breadcrumb. */
	kind: ReactNode;
	title: string;
	/** Text the rename field starts with; defaults to the title. */
	renameFrom?: string;
	meta: ReactNode;
	tracks: readonly Track[];
	/** Shown in place of the cover while no song has artwork. */
	fallbackIcon: ReactNode;
	onRename: (name: string) => void;
	onDelete: () => void;
	/** Shared / Private switch beside the buttons (shown while in a shared library). */
	sharing?: ReactNode;
	/** Extra content under the buttons, such as subtags. */
	children?: ReactNode;
}

/** Header of a playlist or tag page: covers, name, figures, and Play / Rename / Delete. */
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
	children,
}: CollectionProps) {
	const player = usePlayer();
	const [editing, setEditing] = useState(false);
	return (
		<PageHeader
			art={<Cover tracks={tracks} fallback={fallbackIcon} className="size-28" />}
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
			meta={meta}
			actions={
				<>
					<Button disabled={tracks.length === 0} onClick={() => player.play(tracks, 0)}>
						<Play /> Play
					</Button>
					<Button variant="outline" onClick={() => setEditing(true)} disabled={editing}>
						<Pencil /> Rename
					</Button>
					{sharing}
					<Button variant="ghost" onClick={onDelete} className="hover:text-destructive">
						<Trash2 /> Delete
					</Button>
				</>
			}
		>
			{children}
		</PageHeader>
	);
}
