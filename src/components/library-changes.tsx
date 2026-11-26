import {
	ArrowDownToLine,
	AudioWaveform,
	Database,
	FileAudio,
	ListMusic,
	Sparkles,
	Tag,
} from "lucide-react";
import type { ReactNode } from "react";
import { WellCard } from "#/components/frame.tsx";
import { EmptyState, ErrorLine, Page } from "#/components/page.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import type { DeleteHold, FileRemoval, LibraryChange, LibraryChangeBatch } from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { changedBy, changeFacts, changeTitle } from "#/lib/library-changes.ts";
import { TRASH } from "#/lib/platform.ts";
import {
	useDecideDeletes,
	useFileRemovals,
	useLibraryChanges,
	useLibrarySyncStatus,
	useSettleFileRemovals,
	useUndoLibraryChanges,
} from "#/lib/queries.ts";

const ICON: Record<LibraryChange["kind"], ReactNode> = {
	tag: <Tag />,
	playlist: <ListMusic />,
	smart_playlist: <Sparkles />,
	analysis: <AudioWaveform />,
	tag_custom: <Database />,
	song_tags: <FileAudio />,
};

/** How many changes of a sync are listed before the rest becomes a count. */
const CHANGES_SHOWN = 5;

function ChangeLine({ change }: { change: LibraryChange }) {
	const facts = changeFacts(change);
	return (
		<li className="flex items-baseline gap-2 text-sm">
			<span className="translate-y-0.5 text-muted-foreground [&_svg]:size-3.5">
				{ICON[change.kind]}
			</span>
			<span className="min-w-0 truncate">{changeTitle(change)}</span>
			{facts.length > 0 && (
				<span className="shrink-0 text-muted-foreground text-xs">{facts.join(" · ")}</span>
			)}
		</li>
	);
}

/** One sync's changes: who made them and when, what they did, and a way to take them back. */
function BatchRow({ batch }: { batch: LibraryChangeBatch }) {
	const undo = useUndoLibraryChanges();
	const shown = batch.changes.slice(0, CHANGES_SHOWN);
	const more = batch.changes.length - shown.length;
	const left = undo.data?.skipped ?? 0;
	return (
		<div className="space-y-2 px-4 py-3">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1 truncate text-sm">
					<span className="font-medium">{changedBy(batch.by)}</span>{" "}
					<span className="text-muted-foreground text-xs">{timeAgo(batch.at)}</span>
				</div>
				{batch.undone ? (
					<span className="text-muted-foreground text-xs">Undone</span>
				) : (
					<ConfirmButton
						size="xs"
						variant="outline"
						disabled={undo.isPending}
						confirmLabel="Undo for everyone"
						consequence="Puts back what these changes replaced, on every device. Anything changed since stays as it is, and so do renamed and merged tags."
						onConfirm={() => undo.mutate(batch.id)}
					>
						Undo
					</ConfirmButton>
				)}
			</div>
			<ul className="space-y-1">
				{shown.map((change) => (
					<ChangeLine key={`${change.kind}/${change.name}`} change={change} />
				))}
				{more > 0 && (
					<li className="text-muted-foreground text-xs">and {more.toLocaleString()} more</li>
				)}
			</ul>
			{left > 0 && (
				<p className="text-muted-foreground text-xs">
					{left === 1 ? "1 change was" : `${left.toLocaleString()} changes were`} left as they are.
				</p>
			)}
			{undo.isError && <ErrorLine>{String(undo.error)}</ErrorLine>}
		</div>
	);
}

/** Deletions a sync held back: what they are, and the two things that can be done about them. */
function HeldDeletions({ hold }: { hold: DeleteHold }) {
	const decide = useDecideDeletes();
	const rest = hold.count - hold.names.length;
	return (
		<WellCard wellClassName="space-y-3 px-4 py-4">
			<div>
				<p className="font-medium text-sm">
					{changedBy(hold.by)} deleted {hold.count.toLocaleString()} tags and playlists
				</p>
				<p className="text-muted-foreground text-xs">
					Held {timeAgo(hold.at)}. Nothing else arrives until you choose; your own edits still go
					out.
				</p>
			</div>
			<Facts label={`Would be deleted here: ${hold.names.join(", ")}`}>
				{hold.names.map((name) => (
					<Fact key={name} tone="lost">
						{name}
					</Fact>
				))}
				{rest > 0 && <Fact>and {rest.toLocaleString()} more</Fact>}
			</Facts>
			<div className="flex flex-wrap gap-2">
				<ConfirmButton
					variant="outline"
					disabled={decide.isPending}
					confirmLabel="Keep them for everyone"
					consequence="The deletions are taken back: every device gets these tags and playlists again, with their songs."
					onConfirm={() => decide.mutate("keep")}
				>
					Keep them
				</ConfirmButton>
				<ConfirmButton
					variant="outline"
					destructive
					disabled={decide.isPending}
					confirmLabel="Delete them here too"
					consequence="They go from this device as they did from the other. Recently deleted keeps them for 90 days."
					onConfirm={() => decide.mutate("apply")}
				>
					Delete them here
				</ConfirmButton>
			</div>
			{decide.isError && <ErrorLine>{String(decide.error)}</ErrorLine>}
		</WellCard>
	);
}

/** How many removed songs are listed before the rest becomes a count. */
const REMOVALS_SHOWN = 8;

/**
 * Songs another device removed from the shared library that are still here. Nothing is deleted
 * until the user says so, song by song or all at once.
 */
function RemovedSongs({ removals }: { removals: FileRemoval[] }) {
	const settle = useSettleFileRemovals();
	const all = removals.map((removal) => removal.audioFp);
	const shown = removals.slice(0, REMOVALS_SHOWN);
	const more = removals.length - shown.length;
	const count = removals.length === 1 ? "1 song" : `${removals.length.toLocaleString()} songs`;
	return (
		<WellCard wellClassName="space-y-3 px-4 py-4">
			<div>
				<p className="font-medium text-sm">{count} removed on another device</p>
				<p className="text-muted-foreground text-xs">
					Still in this library. Remove them here too, or keep them and every device has them again.
				</p>
			</div>
			<ul className="space-y-1.5">
				{shown.map((removal) => (
					<li key={removal.audioFp} className="flex items-center gap-2 text-sm">
						<div className="min-w-0 flex-1">
							<div className="truncate">
								{removal.title || removal.path}
								{removal.artist && (
									<span className="text-muted-foreground"> · {removal.artist}</span>
								)}
							</div>
							<div className="truncate text-muted-foreground text-xs">
								{removal.path} · {removal.by}, {timeAgo(removal.at)}
							</div>
						</div>
						<ConfirmButton
							size="xs"
							variant="outline"
							disabled={settle.isPending}
							confirmLabel="Keep for everyone"
							consequence="Every device has this song again; one that no longer has the file gets it back."
							onConfirm={() => settle.mutate({ choice: "keep", audioFps: [removal.audioFp] })}
						>
							Keep
						</ConfirmButton>
						<ConfirmButton
							size="xs"
							variant="outline"
							destructive
							disabled={settle.isPending}
							confirmLabel={`Move to ${TRASH}`}
							consequence={`The file goes to the ${TRASH} on this device.`}
							onConfirm={() => settle.mutate({ choice: "remove", audioFps: [removal.audioFp] })}
						>
							Remove
						</ConfirmButton>
					</li>
				))}
				{more > 0 && (
					<li className="text-muted-foreground text-xs">and {more.toLocaleString()} more</li>
				)}
			</ul>
			{removals.length > 1 && (
				<div className="flex flex-wrap gap-2">
					<ConfirmButton
						variant="outline"
						disabled={settle.isPending}
						confirmLabel={`Keep all ${removals.length.toLocaleString()} for everyone`}
						consequence="Every device has these songs again; one that no longer has the files gets them back."
						onConfirm={() => settle.mutate({ choice: "keep", audioFps: all })}
					>
						Keep all
					</ConfirmButton>
					<ConfirmButton
						variant="outline"
						destructive
						disabled={settle.isPending}
						confirmLabel={`Move all ${removals.length.toLocaleString()} to ${TRASH}`}
						consequence={`Their files go to the ${TRASH} on this device.`}
						onConfirm={() => settle.mutate({ choice: "remove", audioFps: all })}
					>
						Remove all here
					</ConfirmButton>
				</div>
			)}
			{settle.isError && <ErrorLine>{String(settle.error)}</ErrorLine>}
		</WellCard>
	);
}

/**
 * What other devices changed in the shared library in the last 30 days, one entry per sync, each
 * with Undo; and on top, what waits for a choice: deletions a sync held back because there were
 * many at once, and songs another device removed that are still here.
 */
export function LibraryChanges() {
	const batches = useLibraryChanges().data ?? [];
	const hold = useLibrarySyncStatus().data?.hold ?? null;
	const removals = useFileRemovals().data ?? [];
	const waiting = hold !== null || removals.length > 0;
	return (
		<Page
			title="Changes"
			meta={
				batches.length > 0 && (
					<span>
						{batches.length === 1 ? "1 sync" : `${batches.length.toLocaleString()} syncs`}
					</span>
				)
			}
		>
			{hold && <HeldDeletions hold={hold} />}
			{removals.length > 0 && <RemovedSongs removals={removals} />}
			{batches.length === 0 ? (
				!waiting && (
					<EmptyState icon={<ArrowDownToLine />} title="Nothing changed">
						What other devices change in the shared library shows here for 30 days.
					</EmptyState>
				)
			) : (
				<WellCard rows>
					{batches.map((batch) => (
						<BatchRow key={batch.id} batch={batch} />
					))}
				</WellCard>
			)}
		</Page>
	);
}
