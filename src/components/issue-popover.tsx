import { Popover } from "@base-ui/react/popover";
import { TriangleAlert, Wrench } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { cardFor, type IssueIndex, type PlaceDefaults } from "#/lib/audit.ts";
import { useAuditPlace } from "#/lib/queries.ts";

interface Props {
	path: string;
	isDir: boolean;
	health: IssueIndex;
	fixing: boolean;
	/** Fixes the fixable files at or under these paths (after asking the user). */
	onFix: (scopes: string[]) => unknown;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const popup =
	"z-50 w-72 rounded-lg border bg-popover p-3 text-popover-foreground text-sm shadow-lg outline-none";

/** Warning icon that opens a card: what is wrong here, and how to fix it. */
export function IssuePopover({ path, isDir, health, fixing, onFix, open, onOpenChange }: Props) {
	const card = cardFor(path, isDir, health);
	if (card === null) {
		return null;
	}
	return (
		<Popover.Root open={open} onOpenChange={onOpenChange}>
			<Popover.Trigger
				aria-label="Show issues"
				className="flex shrink-0 items-center gap-1 rounded px-1 text-amber-500 text-xs hover:bg-amber-500/15"
				onClick={(ev) => ev.stopPropagation()}
				onDoubleClick={(ev) => ev.stopPropagation()}
				onMouseDown={(ev) => ev.stopPropagation()}
			>
				<TriangleAlert className="size-3.5" />
				{isDir && health.folders.get(path)?.count}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner sideOffset={6} className="z-50">
					{/* The card lives inside the pane in the React tree; keep its keys (Enter, typing) to itself. */}
					<Popover.Popup className={popup} onKeyDown={(ev) => ev.stopPropagation()}>
						<div className="space-y-2">
							{card.title && <p className="font-medium">{card.title}</p>}
							<ul className="space-y-1 text-muted-foreground text-xs">
								{card.lines.map((l) => (
									<li key={l}>• {l}</li>
								))}
							</ul>
							{card.fixable > 0 && (
								<Button
									size="sm"
									className="w-full"
									disabled={fixing}
									onClick={() => onFix([path])}
								>
									<Wrench />
									{fixing ? "Fixing…" : card.fixLabel}
								</Button>
							)}
							{card.form && (
								<PlaceForm path={path} defaults={card.form} onDone={() => onOpenChange(false)} />
							)}
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Asks for the artist and album of a song that cannot be filed on its own, then files it. */
function PlaceForm({
	path,
	defaults,
	onDone,
}: {
	path: string;
	defaults: PlaceDefaults;
	onDone: () => void;
}) {
	const [artist, setArtist] = useState(defaults.artist ?? "");
	const [album, setAlbum] = useState(defaults.album ?? "");
	const place = useAuditPlace();
	const ready = artist.trim() !== "" && album.trim() !== "";
	return (
		<form
			className="space-y-2 border-t pt-2"
			onSubmit={(ev) => {
				ev.preventDefault();
				place.mutate({ path, artist, album }, { onSuccess: onDone });
			}}
		>
			<p className="text-xs">Where does this song go?</p>
			<Input
				autoFocus={defaults.artist === null}
				value={artist}
				placeholder="Artist"
				aria-label="Artist"
				onChange={(ev) => setArtist(ev.target.value)}
			/>
			<Input
				autoFocus={defaults.artist !== null}
				value={album}
				placeholder="Album"
				aria-label="Album"
				onChange={(ev) => setAlbum(ev.target.value)}
			/>
			{place.isError && <p className="text-destructive text-xs">{String(place.error)}</p>}
			<Button type="submit" size="sm" className="w-full" disabled={!ready || place.isPending}>
				{place.isPending ? "Moving…" : "Create folder and move"}
			</Button>
		</form>
	);
}
