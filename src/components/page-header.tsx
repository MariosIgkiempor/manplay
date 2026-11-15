import { Check, Pencil, Play, Trash2, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { AlbumArt } from "#/components/album-art.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { usePlayer } from "#/context/player-context.ts";
import { groupAlbums } from "#/lib/albums.ts";
import type { Track } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";

/** Four album covers in a grid, one cover when fewer albums exist, or `fallback` for none. */
export function Cover({
	tracks,
	fallback,
	className = "size-36",
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

interface Props {
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
	/** Extra content under the buttons, such as subtags. */
	children?: ReactNode;
}

/** Header of a playlist or tag page: cover, name, figures, and Play / Rename / Delete. */
export function PageHeader({
	kind,
	title,
	renameFrom,
	meta,
	tracks,
	fallbackIcon,
	onRename,
	onDelete,
	children,
}: Props) {
	const player = usePlayer();
	const [editing, setEditing] = useState(false);
	return (
		<header className="flex items-end gap-6 border-b bg-card/40 px-6 pt-8 pb-6">
			<Cover tracks={tracks} fallback={fallbackIcon} />
			<div className="min-w-0 flex-1 space-y-3">
				<div className="space-y-1">
					<div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-sm">
						{kind}
					</div>
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
					<div className="flex items-center gap-3 text-muted-foreground text-sm">{meta}</div>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button disabled={tracks.length === 0} onClick={() => player.play(tracks, 0)}>
						<Play /> Play
					</Button>
					<Button variant="outline" onClick={() => setEditing(true)} disabled={editing}>
						<Pencil /> Rename
					</Button>
					<Button variant="ghost" onClick={onDelete} className="hover:text-destructive">
						<Trash2 /> Delete
					</Button>
				</div>
				{children}
			</div>
		</header>
	);
}
