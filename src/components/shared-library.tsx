import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ClashList } from "#/components/clashes.tsx";
import { ConfirmDialog, Dialog } from "#/components/confirm-dialog.tsx";
import { ScopeSwitch } from "#/components/item-sharing.tsx";
import { ErrorLine, Panel, Section } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	type FoundLibrary,
	type JoinChoice,
	type LeaveChoice,
	libsyncInspect,
	libsyncReplaceCount,
	type SyncTarget,
	targetName,
} from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import {
	useClashes,
	useDefaultScope,
	useJoinLibrary,
	useLeaveLibrary,
	useSyncTargets,
} from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** What this device calls the shared library on a destination. */
function libraryLabel(t: SyncTarget): string {
	return t.libraryName ?? targetName(t);
}

/** Whether this destination holds the device's shared library or only takes the files. */
export function LibraryBadge({ target, className }: { target: SyncTarget; className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs",
				target.libsync ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
				className,
			)}
		>
			{target.libsync ? "Shared library" : "Files only"}
		</span>
	);
}

/** One answer in a dialog that has several: what it is, and what it does. */
function Choice({
	label,
	hint,
	onClick,
	disabled,
	tone = "plain",
}: {
	label: string;
	hint: string;
	onClick: () => void;
	disabled?: boolean;
	tone?: "main" | "plain" | "danger";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"w-full rounded-lg border px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50",
				tone === "main" && "border-primary/50 bg-primary/5",
				tone === "danger" && "border-destructive/40",
			)}
		>
			<span className="block font-medium text-foreground text-sm">{label}</span>
			<span className="block text-muted-foreground text-xs">{hint}</span>
		</button>
	);
}

/** Leaving the library: keep what was shared as local items, or only what was always local. */
export function LeaveLibraryDialog({
	target,
	title,
	onDone,
	onCancel,
}: {
	target: SyncTarget;
	title?: string;
	onDone: () => void;
	onCancel: () => void;
}) {
	const leave = useLeaveLibrary();
	const [last, setLast] = useState<LeaveChoice>("keepCopy");
	const go = (choice: LeaveChoice, sync: boolean) => {
		setLast(choice);
		leave.mutate({ choice, sync }, { onSuccess: onDone });
	};
	return (
		<Dialog
			title={title ?? `Leave ${libraryLabel(target)}?`}
			onCancel={onCancel}
			footer={
				<div className="space-y-2">
					<Choice
						tone="main"
						label="Keep a copy"
						hint="Syncs once more, then every shared tag and playlist stays here as a local one."
						disabled={leave.isPending}
						onClick={() => go("keepCopy", true)}
					/>
					<Choice
						label="Keep only my local items"
						hint="Syncs once more, then shared tags and playlists are removed from this device."
						disabled={leave.isPending}
						onClick={() => go("keepLocal", true)}
					/>
					{leave.isError && (
						<div className="space-y-2">
							<ErrorLine>{String(leave.error)}</ErrorLine>
							<Button variant="outline" disabled={leave.isPending} onClick={() => go(last, false)}>
								Leave without syncing
							</Button>
						</div>
					)}
					<div className="flex items-center justify-end gap-2">
						{leave.isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
						<Button variant="ghost" onClick={onCancel}>
							Cancel
						</Button>
					</div>
				</div>
			}
		>
			Other members keep the library and everything you sent. This device stops reading and writing{" "}
			<code>.manplay</code> there.
		</Dialog>
	);
}

function Members({ found }: { found: FoundLibrary }) {
	return (
		<div className="space-y-2">
			<ul className="space-y-0.5">
				{found.members.map((m) => (
					<li key={`${m.name}-${m.lastSeen}`} className="flex justify-between gap-3 text-xs">
						<span className="truncate">
							{m.name}
							{m.mine && " (this device)"}
						</span>
						<span className="shrink-0 tabular-nums">{timeAgo(m.lastSeen)}</span>
					</li>
				))}
			</ul>
			<p className="text-xs">
				{found.lastChange === null
					? "No device has synced yet"
					: `Last change ${timeAgo(found.lastChange)}`}
			</p>
		</div>
	);
}

/** "Replace mine" drops everything this device has: ask once more with the count. */
function ReplaceConfirm({
	busy,
	onCancel,
	onConfirm,
}: {
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const count = useQuery({ queryKey: ["library-replace-count"], queryFn: libsyncReplaceCount });
	const n = count.data;
	return (
		<ConfirmDialog
			title="Replace your tags and playlists?"
			confirmLabel="Replace mine"
			destructive
			busy={busy || n === undefined}
			onCancel={onCancel}
			onConfirm={onConfirm}
		>
			{n === undefined
				? "Counting…"
				: `${n.toLocaleString()} of your tags, playlists and smart playlists are removed from this device and replaced by the shared ones. Songs and files are not touched.`}
		</ConfirmDialog>
	);
}

type Stage = "leave" | "look" | "replace";

/**
 * Reads what a destination holds and asks what to do about it: join (three ways), start a
 * library, or keep it files only. A device is in one library at a time, so a device that is in
 * another one is asked to leave it first.
 */
export function JoinLibraryDialog({
	target,
	onClose,
}: {
	target: SyncTarget;
	onClose: () => void;
}) {
	const targets = useSyncTargets();
	const other = targets.data?.find((t) => t.libsync && t.id !== target.id);
	const [stage, setStage] = useState<Stage>(other ? "leave" : "look");
	const join = useJoinLibrary();
	const [note, setNote] = useState<string | null>(null);
	const found = useQuery({
		queryKey: ["library-inspect", target.id],
		queryFn: () => libsyncInspect(target.id),
		enabled: stage !== "leave",
		retry: false,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	const go = (choice: JoinChoice) =>
		join.mutate(
			{ id: target.id, choice },
			{
				onSuccess: (out) => {
					if (out.error) {
						setNote(out.error);
					} else {
						onClose();
					}
				},
			},
		);
	const where = targetName(target);

	if (stage === "leave" && other) {
		return (
			<LeaveLibraryDialog
				target={other}
				title={`Leave ${libraryLabel(other)} to join ${where}?`}
				onDone={() => setStage("look")}
				onCancel={onClose}
			/>
		);
	}
	if (note !== null) {
		return (
			<Dialog
				title="Joined, but the first sync did not finish"
				onCancel={onClose}
				footer={
					<div className="flex justify-end">
						<Button onClick={onClose}>Close</Button>
					</div>
				}
			>
				{note} It is tried again at the next sync.
			</Dialog>
		);
	}
	if (stage === "replace") {
		return (
			<>
				<ReplaceConfirm
					busy={join.isPending}
					onCancel={() => setStage("look")}
					onConfirm={() => go("replace")}
				/>
				{join.isError && <FloatingError error={join.error} />}
			</>
		);
	}
	return (
		<LookDialog
			target={target}
			found={found}
			join={join}
			onChoose={go}
			onReplace={() => setStage("replace")}
			onClose={onClose}
		/>
	);
}

type Inspect = UseQueryResult<FoundLibrary | null>;
type Join = ReturnType<typeof useJoinLibrary>;

/** What the destination holds, and the ways to join it, start one there, or not share. */
function LookDialog({
	target,
	found,
	join,
	onChoose,
	onReplace,
	onClose,
}: {
	target: SyncTarget;
	found: Inspect;
	join: Join;
	onChoose: (choice: JoinChoice) => void;
	onReplace: () => void;
	onClose: () => void;
}) {
	const where = targetName(target);

	const filesOnly = (
		<Button variant="ghost" onClick={onClose} disabled={join.isPending}>
			Files only
		</Button>
	);
	if (found.isPending || found.isFetching) {
		return (
			<Dialog title={`Looking in ${where}`} onCancel={onClose} footer={null}>
				<span className="inline-flex items-center gap-2">
					<Loader2 className="size-4 animate-spin" /> Checking for a shared library…
				</span>
			</Dialog>
		);
	}
	if (found.isError) {
		return (
			<Dialog
				title={`Could not look in ${where}`}
				onCancel={onClose}
				footer={
					<div className="flex justify-end gap-2">
						{filesOnly}
						<Button onClick={() => found.refetch()}>Try again</Button>
					</div>
				}
			>
				{String(found.error)}
			</Dialog>
		);
	}
	if (found.data === null) {
		return (
			<Dialog
				title={`Start a shared library on ${where}?`}
				onCancel={onClose}
				footer={
					<div className="space-y-2">
						<Choice
							tone="main"
							label="Start a shared library"
							hint="Your tags and playlists are shared. Make any of them private from its page."
							disabled={join.isPending}
							onClick={() => onChoose("start")}
						/>
						<Choice
							label="Files only"
							hint="Copy the songs and nothing else. manplay writes nothing more here."
							disabled={join.isPending}
							onClick={onClose}
						/>
						{join.isError && <ErrorLine>{String(join.error)}</ErrorLine>}
						{join.isPending && (
							<span className="inline-flex items-center gap-2 text-muted-foreground text-xs">
								<Loader2 className="size-4 animate-spin" /> Starting the library…
							</span>
						)}
					</div>
				}
			>
				<p>
					Your other devices can join it when they add this destination. The songs stay plain files,
					so Jellyfin sees them as before.
				</p>
				<dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt className="text-foreground">Shared</dt>
					<dd>Tags, playlists, smart playlists, BPM, key, beat grids, waveforms</dd>
					<dt className="text-foreground">Stays here</dt>
					<dd>Cues and settings</dd>
				</dl>
			</Dialog>
		);
	}
	const library = found.data;
	return (
		<Dialog
			title={`Library found: ${library.name}`}
			onCancel={onClose}
			footer={
				<div className="space-y-2">
					<Choice
						tone="main"
						label="Join and merge"
						hint="Your tags and playlists become shared. Same names go to Clashes."
						disabled={join.isPending}
						onClick={() => onChoose("merge")}
					/>
					<Choice
						label="Join, keep mine local"
						hint="You receive everything shared. Yours stay on this device."
						disabled={join.isPending}
						onClick={() => onChoose("keepLocal")}
					/>
					<Choice
						tone="danger"
						label="Join and replace mine"
						hint="Drops your tags and playlists and takes theirs."
						disabled={join.isPending}
						onClick={() => onReplace()}
					/>
					<Choice
						label="Files only"
						hint="Don't join. manplay never reads or writes .manplay there."
						disabled={join.isPending}
						onClick={onClose}
					/>
					{join.isError && <ErrorLine>{String(join.error)}</ErrorLine>}
					{join.isPending && (
						<span className="inline-flex items-center gap-2 text-muted-foreground text-xs">
							<Loader2 className="size-4 animate-spin" /> Joining and syncing…
						</span>
					)}
				</div>
			}
		>
			<Members found={library} />
		</Dialog>
	);
}

function FloatingError({ error }: { error: unknown }): ReactNode {
	return (
		<div className="fixed inset-x-0 bottom-6 z-[60] mx-auto w-[28rem] max-w-[calc(100%-2rem)] rounded-lg border bg-background p-3 shadow-lg">
			<ErrorLine>{String(error)}</ErrorLine>
		</div>
	);
}

function MemberList({ target }: { target: SyncTarget }) {
	const found = useQuery({
		queryKey: ["library-inspect", target.id],
		queryFn: () => libsyncInspect(target.id),
		retry: false,
		staleTime: 60_000,
	});
	if (found.isPending) {
		return (
			<p className="inline-flex items-center gap-2 text-muted-foreground text-xs">
				<Loader2 className="size-3.5 animate-spin" /> Reading members…
			</p>
		);
	}
	if (found.isError || !found.data) {
		return (
			<p className="text-muted-foreground text-xs">
				Members show when {targetName(target)} can be reached.
			</p>
		);
	}
	return (
		<ul className="space-y-1">
			{found.data.members.map((m) => (
				<li key={`${m.name}-${m.lastSeen}`} className="flex items-baseline gap-3 text-sm">
					<span className="min-w-0 flex-1 truncate">
						{m.name}
						{m.mine && <span className="text-muted-foreground"> (this device)</span>}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						synced {timeAgo(m.lastSeen)}
					</span>
				</li>
			))}
		</ul>
	);
}

/** The scope new tags and playlists get, as a setting. */
function DefaultScope() {
	const { scope, save } = useDefaultScope();
	return (
		<div className="flex items-center gap-4">
			<div className="min-w-0 flex-1">
				<p className="font-medium text-sm">New tags and playlists</p>
				<p className="text-muted-foreground text-xs">
					Where they start. Each one can be switched later from its page header.
				</p>
			</div>
			<ScopeSwitch
				value={scope.data ?? "shared"}
				disabled={scope.data === undefined || save.isPending}
				onChange={(next) => save.mutate(next)}
			/>
		</div>
	);
}

/**
 * Settings for the shared library: which one this device is in, who else is, what new items
 * start as, and clashes to settle. Outside a library, each destination can start or join one.
 */
export function SharedLibrarySettings() {
	const targets = useSyncTargets().data ?? [];
	const mine = targets.find((t) => t.libsync);
	const [joining, setJoining] = useState<SyncTarget | null>(null);
	const [leaving, setLeaving] = useState(false);
	return (
		<Section title="Shared library">
			{mine ? (
				<>
					<Panel className="divide-y p-0 [&>*]:px-4 [&>*]:py-3">
						<div className="flex items-center gap-3">
							<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary [&_svg]:size-4">
								<Users />
							</span>
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium">{libraryLabel(mine)}</p>
								<p className="truncate text-muted-foreground text-xs">
									Kept on {targetName(mine)}. Tags, playlists, smart playlists, BPM, key, beat grids
									and waveforms sync there. Cues stay on this device.
								</p>
							</div>
							<Button variant="outline" onClick={() => setLeaving(true)}>
								Leave…
							</Button>
						</div>
						<div className="space-y-2">
							<p className="font-medium text-sm">Members</p>
							<MemberList target={mine} />
						</div>
						<DefaultScope />
					</Panel>
					<ClashPanel />
				</>
			) : (
				<Panel className="space-y-3">
					<p className="text-muted-foreground text-sm">
						Share tags, playlists, smart playlists, BPM, key, beat grids and waveforms with your
						other devices through one of your destinations. The songs stay plain files.
					</p>
					{targets.length === 0 ? (
						<p className="text-muted-foreground text-sm">Add a destination under Export first.</p>
					) : (
						<ul className="divide-y rounded-md border">
							{targets.map((t) => (
								<li key={t.id} className="flex items-center gap-3 px-3 py-2">
									<span className="min-w-0 flex-1 truncate text-sm">{targetName(t)}</span>
									<Button size="sm" variant="outline" onClick={() => setJoining(t)}>
										Start or join…
									</Button>
								</li>
							))}
						</ul>
					)}
				</Panel>
			)}
			{joining && <JoinLibraryDialog target={joining} onClose={() => setJoining(null)} />}
			{leaving && mine && (
				<LeaveLibraryDialog
					target={mine}
					onDone={() => setLeaving(false)}
					onCancel={() => setLeaving(false)}
				/>
			)}
		</Section>
	);
}

/** Clashes, framed for the settings page. Nothing when there are none. */
function ClashPanel() {
	const count = useClashes().data?.length ?? 0;
	if (count === 0) {
		return null;
	}
	return (
		<Panel className="overflow-hidden p-0 [--diff-inset:1rem] [&_section]:border-b-0">
			<ClashList />
		</Panel>
	);
}
