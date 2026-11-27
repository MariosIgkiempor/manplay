import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { FileAudio, FolderOpen, Server, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClashList } from "#/components/clashes.tsx";
import { Dialog } from "#/components/confirm-dialog.tsx";
import { DeviceNameRow } from "#/components/device-settings.tsx";
import { FieldRow, FrameSection } from "#/components/frame.tsx";
import { ScopeSwitch } from "#/components/item-sharing.tsx";
import { ErrorLine, LoadingLine } from "#/components/page.tsx";
import { StatusIcon } from "#/components/status-icon.tsx";
import { StreamedLeaveChoice } from "#/components/streamed-leave-choice.tsx";
import { StreamingSettings } from "#/components/streaming-settings.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Fact, Facts, MoreInfo } from "#/components/ui/facts.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import {
	type FoundLibrary,
	type JoinChoice,
	type LastLibrarySync,
	type LeaveChoice,
	type LibraryHome,
	libsyncInspect,
	libsyncInspectFolder,
	type StreamedOnLeaving,
	type SyncTarget,
	targetName,
} from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import {
	type LibraryPlace,
	useClashes,
	useDefaultScope,
	useJoinLibrary,
	useLeaveLibrary,
	useLibraryHome,
	useLibraryRoot,
	useLibrarySyncStatus,
	useLibrarySyncWatch,
	useRemoveUnavailableStreamedSongs,
	useSetLibraryAuto,
	useStreamedSongs,
	useSyncLibraryNow,
	useSyncTargets,
} from "#/lib/queries.ts";
import { CLASHES_ANCHOR } from "#/lib/settings-sections.ts";
import { cn } from "#/lib/utils.ts";

/** What a shared library carries between computers. */
const SHARED_KINDS = [
	"Tags",
	"Playlists",
	"Smart playlists",
	"BPM",
	"Key",
	"Beat grids",
	"Waveforms",
] as const;
/** The last part of a folder path, for a library named after its folder. */
function folderName(root: string): string {
	return root.split(/[/\\]/).filter(Boolean).at(-1) ?? root;
}

/** What this device calls the library it is in, wherever it is kept; null outside one. */
function homeLabel(home: LibraryHome, targets: SyncTarget[]): string | null {
	switch (home.kind) {
		case "none":
			return null;
		case "folder":
			return home.name ?? folderName(home.root);
		case "target": {
			const target = targets.find((t) => t.id === home.targetId);
			return home.name ?? (target ? targetName(target) : "the shared library");
		}
	}
}

/** Whether the library this device is in is kept at `place`. */
function isHome(home: LibraryHome, place: LibraryPlace): boolean {
	return place.kind === "folder"
		? home.kind === "folder"
		: home.kind === "target" && home.targetId === place.target.id;
}

/** How a sentence names a place: the destination's name, or "your library folder". */
function placeName(place: LibraryPlace): string {
	return place.kind === "target" ? targetName(place.target) : "your library folder";
}

/** Reads what a place holds; writes nothing. */
function useInspect(place: LibraryPlace, options: { enabled?: boolean; staleTime?: number }) {
	return useQuery({
		queryKey: ["library-inspect", place.kind === "target" ? place.target.id : "folder"],
		queryFn: () =>
			place.kind === "target" ? libsyncInspect(place.target.id) : libsyncInspectFolder(),
		retry: false,
		...options,
	});
}

/** Whether this destination holds the device's shared library or only takes the files. */
export function LibraryBadge({
	target,
	className,
	focusable = true,
}: {
	target: SyncTarget;
	className?: string;
	/** Off inside something already focusable, such as a sidebar row. */
	focusable?: boolean;
}) {
	return target.libsync ? (
		<StatusIcon
			focusable={focusable}
			icon={<Users />}
			tone="primary"
			label="Shared library"
			detail="Tags, playlists and analysis sync through here, as well as the files."
			className={className}
		/>
	) : (
		<StatusIcon
			focusable={focusable}
			icon={<FileAudio />}
			label="Files only"
			detail="Only the song files sync here. Tags and playlists stay on this device."
			className={className}
		/>
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
	label,
	title,
	onDone,
	onCancel,
}: {
	/** What this device calls the library. */
	label: string;
	title?: string;
	onDone: () => void;
	onCancel: () => void;
}) {
	const leave = useLeaveLibrary();
	const [last, setLast] = useState<LeaveChoice>("keepCopy");
	const [streamed, setStreamed] = useState<StreamedOnLeaving>("download");
	const streaming = useStreamedSongs().data;
	const streamedCount = streaming?.playable ? streaming.count : 0;
	const go = (choice: LeaveChoice, sync: boolean) => {
		setLast(choice);
		leave.mutate(
			{ choice, sync, streamed: streamedCount > 0 ? streamed : undefined },
			{ onSuccess: onDone },
		);
	};
	return (
		<Dialog
			title={title ?? `Leave ${label}?`}
			onCancel={onCancel}
			footer={
				<div className="space-y-2">
					<Choice
						tone="main"
						label="Keep a copy"
						hint="Syncs once more, then shared tags and playlists stay here as local ones."
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
						{leave.isPending && (
							<LoadingLine>
								{streamedCount > 0 && streamed === "download"
									? "Downloading the streamed songs, then leaving…"
									: "Leaving…"}
							</LoadingLine>
						)}
						<Button variant="ghost" onClick={onCancel}>
							Cancel
						</Button>
					</div>
				</div>
			}
		>
			Other members keep the library and everything you sent. This device stops reading and writing{" "}
			<code>.manplay</code> there.
			{streamedCount > 0 && (
				<StreamedLeaveChoice
					count={streamedCount}
					value={streamed}
					onChange={setStreamed}
					disabled={leave.isPending}
				/>
			)}
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

type Stage = "leave" | "look";

/**
 * Reads what a destination (or the library folder) holds and asks what to do about it: join
 * (two ways), start a library, or leave it be. A device is in one library at a time, so a device
 * that is in another one is asked to leave it first.
 */
export function JoinLibraryDialog({
	place,
	onClose,
}: {
	place: LibraryPlace;
	onClose: () => void;
}) {
	const targets = useSyncTargets().data ?? [];
	const home = useLibraryHome().data;
	const other = home && !isHome(home, place) ? homeLabel(home, targets) : null;
	const [stage, setStage] = useState<Stage>(other ? "leave" : "look");
	const join = useJoinLibrary();
	const [note, setNote] = useState<string | null>(null);
	const found = useInspect(place, { enabled: stage !== "leave" });
	const go = (choice: JoinChoice) =>
		join.mutate(
			{ place, choice },
			{
				onSuccess: (error) => {
					if (error) {
						setNote(error);
					} else {
						onClose();
					}
				},
			},
		);
	const where = placeName(place);

	if (stage === "leave" && other) {
		return (
			<LeaveLibraryDialog
				label={other}
				title={`Leave ${other} to join the one in ${where}?`}
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
	return <LookDialog place={place} found={found} join={join} onChoose={go} onClose={onClose} />;
}

type Inspect = UseQueryResult<FoundLibrary | null>;
type Join = ReturnType<typeof useJoinLibrary>;

/** How the dialogs word each kind of place. */
const WORDING = {
	target: {
		startTitle: (where: string) => `Start a shared library on ${where}?`,
		startLabel: "Start a shared library",
		startSummary: "Your other devices join it from this destination.",
		startBody: "Other devices join when they add this destination. Songs stay plain files.",
		starting: "Starting the library…",
		notNow: "Files only",
		notNowHint: "Copy the songs and nothing else. manplay writes nothing more here.",
		foundTitle: (name: string) => `Library found: ${name}`,
		dontJoin: "Files only",
		dontJoinHint: "Don't join. manplay never reads or writes .manplay there.",
	},
	folder: {
		startTitle: () => "Share your library folder?",
		startLabel: "Share this library",
		startSummary: "Computers that open this folder can join.",
		startBody:
			"For a library folder other computers open too, such as a network share or a synced folder. manplay offers to join when they choose it.",
		starting: "Sharing the library…",
		notNow: "Not now",
		notNowHint: "Keep it to this computer. manplay writes nothing more in the folder.",
		foundTitle: (name: string) => `This folder holds a shared library: ${name}`,
		dontJoin: "Don't join",
		dontJoinHint: "Use the songs only. manplay never reads or writes .manplay in the folder.",
	},
} as const;

/** What the place holds, and the ways to join it, start one there, or not share. */
function LookDialog({
	place,
	found,
	join,
	onChoose,
	onClose,
}: {
	place: LibraryPlace;
	found: Inspect;
	join: Join;
	onChoose: (choice: JoinChoice) => void;
	onClose: () => void;
}) {
	const where = placeName(place);
	const words = WORDING[place.kind];
	if (found.isPending || found.isFetching) {
		return (
			<Dialog title={`Looking in ${where}`} onCancel={onClose} footer={null}>
				<LoadingLine>Checking for a shared library…</LoadingLine>
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
						<Button variant="ghost" onClick={onClose} disabled={join.isPending}>
							{words.notNow}
						</Button>
						<Button onClick={() => found.refetch()}>Try again</Button>
					</div>
				}
			>
				{String(found.error)}
			</Dialog>
		);
	}
	if (found.data === null) {
		return <StartDialog place={place} join={join} onChoose={onChoose} onClose={onClose} />;
	}
	return (
		<FoundDialog
			place={place}
			library={found.data}
			join={join}
			onChoose={onChoose}
			onClose={onClose}
		/>
	);
}

/** No library at the place yet: start one there, or leave it be. */
function StartDialog({
	place,
	join,
	onChoose,
	onClose,
}: {
	place: LibraryPlace;
	join: Join;
	onChoose: (choice: JoinChoice) => void;
	onClose: () => void;
}) {
	const words = WORDING[place.kind];
	return (
		<Dialog
			title={words.startTitle(placeName(place))}
			onCancel={onClose}
			footer={
				<div className="space-y-2">
					<Choice
						tone="main"
						label={words.startLabel}
						hint="Tags and playlists are shared. Make any private from its page."
						disabled={join.isPending}
						onClick={() => onChoose("start")}
					/>
					<Choice
						label={words.notNow}
						hint={words.notNowHint}
						disabled={join.isPending}
						onClick={onClose}
					/>
					{join.isError && <ErrorLine>{String(join.error)}</ErrorLine>}
					{join.isPending && <LoadingLine>{words.starting}</LoadingLine>}
				</div>
			}
		>
			<p>
				{words.startSummary} <MoreInfo hint={words.startBody} />
			</p>
			<Facts
				label="Shared: tags, playlists, smart playlists, BPM, key, beat grids, waveforms. Stays here: cues and settings."
				className="mt-3"
			>
				{SHARED_KINDS.map((kind) => (
					<Fact key={kind} tone="sent">
						{kind}
					</Fact>
				))}
				<Fact tone="kept">Cues</Fact>
				<Fact tone="kept">Settings</Fact>
			</Facts>
		</Dialog>
	);
}

/** A library is at the place: who is in it, and the two ways to join. */
function FoundDialog({
	place,
	library,
	join,
	onChoose,
	onClose,
}: {
	place: LibraryPlace;
	library: FoundLibrary;
	join: Join;
	onChoose: (choice: JoinChoice) => void;
	onClose: () => void;
}) {
	const words = WORDING[place.kind];
	return (
		<Dialog
			title={words.foundTitle(library.name)}
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
						label={words.dontJoin}
						hint={words.dontJoinHint}
						disabled={join.isPending}
						onClick={onClose}
					/>
					{join.isError && <ErrorLine>{String(join.error)}</ErrorLine>}
					{join.isPending && <LoadingLine>Joining and syncing…</LoadingLine>}
				</div>
			}
		>
			<Members found={library} />
		</Dialog>
	);
}

function MemberList({ place }: { place: LibraryPlace }) {
	const found = useInspect(place, { staleTime: 60_000 });
	if (found.isPending) {
		return <LoadingLine>Reading members…</LoadingLine>;
	}
	if (found.isError || !found.data) {
		return (
			<p className="text-muted-foreground text-xs">
				Members show when {placeName(place)} can be reached.
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
		<FieldRow
			label="New tags and playlists"
			description={
				<>
					Where they start{" "}
					<MoreInfo hint="Where they start. Each one can be switched later from its page header." />
				</>
			}
			align="center"
		>
			<ScopeSwitch
				value={scope.data ?? "shared"}
				disabled={scope.data === undefined || save.isPending}
				onChange={(next) => save.mutate(next)}
			/>
		</FieldRow>
	);
}

/** How the last sync went, in a few words. */
function lastSyncText(last: LastLibrarySync | null): string {
	if (last === null) {
		return "Not synced yet since manplay opened.";
	}
	const moved = [
		last.sent > 0 ? `${last.sent.toLocaleString()} sent` : null,
		last.received > 0 ? `${last.received.toLocaleString()} received` : null,
	].filter((part) => part !== null);
	return [`Synced ${timeAgo(last.at)}`, ...moved].join(" · ");
}

/**
 * Whether the library syncs on its own, how the last sync went, and a button to sync now. On, it
 * syncs when manplay opens, when its window comes back, shortly after an edit and every 5 minutes.
 */
function AutoSync() {
	const status = useLibrarySyncStatus().data;
	const setAuto = useSetLibraryAuto();
	const syncNow = useSyncLibraryNow();
	const last = status?.last ?? null;
	return (
		<FieldRow
			label="Syncs on its own"
			description={
				<>
					{lastSyncText(last)}{" "}
					<MoreInfo hint="On: when manplay opens, when you come back to it, 30 seconds after an edit and every 5 minutes. Off: only with Sync now or a sync of its destination. Songs are never copied this way." />
					{last?.error && <ErrorLine>{last.error}</ErrorLine>}
				</>
			}
			align="center"
		>
			<div className="flex items-center gap-3">
				<Switch
					label="The shared library syncs on its own"
					checked={status?.auto ?? true}
					disabled={status === undefined || setAuto.isPending}
					onChange={(on) => setAuto.mutate(on)}
				/>
				<Button variant="outline" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
					Sync now
				</Button>
			</div>
		</FieldRow>
	);
}

/** The library this device is in: where it is kept, who else is in it, what new items start as. */
function JoinedRows({
	home,
	place,
	label,
	target,
	onLeave,
}: {
	home: LibraryHome;
	place: LibraryPlace;
	label: string;
	target: SyncTarget | undefined;
	onLeave: () => void;
}) {
	return (
		<>
			<FieldRow
				label={
					<span className="flex items-center gap-2">
						<Users className="size-4 text-primary" />
						{label}
					</span>
				}
				description={
					home.kind === "folder" ? (
						<Facts label={`Kept in your library folder, ${home.root}. Cues stay on this computer.`}>
							<Fact icon={<FolderOpen />}>{home.root}</Fact>
							<Fact tone="kept">Cues stay here</Fact>
						</Facts>
					) : (
						<Facts
							label={`Kept on ${target ? targetName(target) : "a destination"}. Cues stay on this computer.`}
						>
							<Fact icon={<Server />}>{target ? targetName(target) : "A destination"}</Fact>
							<Fact tone="kept">Cues stay here</Fact>
						</Facts>
					)
				}
				align="center"
			>
				<Button variant="outline" onClick={onLeave}>
					Leave…
				</Button>
			</FieldRow>
			<FieldRow label="Members" description="Every computer that reads and writes it.">
				<div className="w-full">
					<MemberList place={place} />
				</div>
			</FieldRow>
			<AutoSync />
			<DefaultScope />
		</>
	);
}

/**
 * Songs listed from a shared library this device left, kept as entries that cannot play (the
 * choice made when leaving): they can be removed from the library here, after a database backup.
 */
function UnavailableSongsRow({ count }: { count: number }) {
	const remove = useRemoveUnavailableStreamedSongs();
	return (
		<FieldRow
			label="Songs that cannot play"
			description={`${count === 1 ? "1 song is" : `${count.toLocaleString()} songs are`} listed from a shared library this device left. They play again after joining it again.`}
			align="center"
		>
			<div className="space-y-1">
				<ConfirmButton
					variant="outline"
					destructive
					disabled={remove.isPending}
					confirmLabel="Remove them from the library"
					consequence="They leave your library, with their places in playlists and tags. A copy of the database is saved first."
					onConfirm={() => remove.mutate()}
				>
					Remove them…
				</ConfirmButton>
				{remove.isError && <ErrorLine>{String(remove.error)}</ErrorLine>}
			</div>
		</FieldRow>
	);
}

/** Outside a library: the library folder and each destination, to start or join one at. */
function PlaceRows({
	root,
	targets,
	onJoin,
}: {
	root: string | null;
	targets: SyncTarget[];
	onJoin: (place: LibraryPlace) => void;
}) {
	return (
		<>
			<FieldRow
				label="Library folder"
				description={
					root ? (
						<>
							Share or join with computers opening it{" "}
							<MoreInfo hint="Share with computers that open this folder, or join the library in it." />
						</>
					) : (
						"Choose a library folder in Library first."
					)
				}
				align="center"
			>
				<Button variant="outline" disabled={!root} onClick={() => onJoin({ kind: "folder" })}>
					Share or join…
				</Button>
			</FieldRow>
			{targets.map((t) => (
				<FieldRow
					key={t.id}
					label={targetName(t)}
					description="Start a library here, or join the one already on it."
					align="center"
				>
					<Button variant="outline" onClick={() => onJoin({ kind: "target", target: t })}>
						Start or join…
					</Button>
				</FieldRow>
			))}
		</>
	);
}

/** Where the library this device is in is kept, as a place; null outside one. */
function homePlace(home: LibraryHome | undefined, target: SyncTarget | undefined) {
	if (home?.kind === "folder") {
		return { kind: "folder" } as const;
	}
	return target ? ({ kind: "target", target } as const) : null;
}

/**
 * Settings for the shared library: which one this device is in, who else is, what new items
 * start as, and clashes to settle. Outside a library, the library folder and each destination
 * can start or join one.
 */
export function SharedLibrarySettings() {
	const targets = useSyncTargets().data ?? [];
	const home = useLibraryHome().data;
	const root = useLibraryRoot().data ?? null;
	const [joining, setJoining] = useState<LibraryPlace | null>(null);
	const [leaving, setLeaving] = useState(false);
	const streaming = useStreamedSongs().data;
	const unavailable = streaming && !streaming.playable ? streaming.count : 0;
	const target = home?.kind === "target" ? targets.find((t) => t.id === home.targetId) : undefined;
	const place = homePlace(home, target);
	const label = home ? homeLabel(home, targets) : null;
	return (
		<>
			<FrameSection
				title="Shared library"
				description={
					<Facts label="Tags, playlists, smart playlists, BPM, key, beat grids and waveforms, shared through a destination or a library folder. Songs stay plain files.">
						{SHARED_KINDS.map((kind) => (
							<Fact key={kind}>{kind}</Fact>
						))}
						<Fact tone="kept">Songs stay plain files</Fact>
					</Facts>
				}
			>
				{home && place && label !== null ? (
					<JoinedRows
						home={home}
						place={place}
						label={label}
						target={target}
						onLeave={() => setLeaving(true)}
					/>
				) : (
					<PlaceRows root={root} targets={targets} onJoin={setJoining} />
				)}
				{unavailable > 0 && <UnavailableSongsRow count={unavailable} />}
				<DeviceNameRow />
				{joining && <JoinLibraryDialog place={joining} onClose={() => setJoining(null)} />}
				{leaving && label !== null && (
					<LeaveLibraryDialog
						label={label}
						onDone={() => setLeaving(false)}
						onCancel={() => setLeaving(false)}
					/>
				)}
			</FrameSection>
			{home?.kind === "target" && <StreamingSettings />}
			<ClashPanel />
		</>
	);
}

const DISMISSED_KEY = "manplay.folder-library-dismissed";

function dismissedLibrary(): string | null {
	try {
		return localStorage.getItem(DISMISSED_KEY);
	} catch {
		return null;
	}
}

function dismissLibrary(libraryId: string) {
	try {
		localStorage.setItem(DISMISSED_KEY, libraryId);
	} catch {
		// Without storage the offer comes back next launch, which is harmless.
	}
}

/**
 * Notices a shared library that other computers keep in the library folder (a network share, a
 * synced folder) and offers to join it, once per library. It also follows the syncs the shared
 * library runs on its own, wherever it is kept, so what arrives shows.
 */
export function FolderLibraryWatch() {
	const home = useLibraryHome().data;
	const root = useLibraryRoot().data ?? null;
	useLibrarySyncWatch();
	const outside = home?.kind === "none" && root !== null;
	const found = useQuery({
		queryKey: ["library-inspect", "folder", root],
		queryFn: libsyncInspectFolder,
		enabled: outside,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const [closed, setClosed] = useState<string | null>(null);
	const library = found.data;
	const offer =
		outside &&
		library &&
		library.members.some((m) => !m.mine) &&
		library.libraryId !== closed &&
		library.libraryId !== dismissedLibrary();
	if (!offer) {
		return null;
	}
	return (
		<JoinLibraryDialog
			place={{ kind: "folder" }}
			onClose={() => {
				dismissLibrary(library.libraryId);
				setClosed(library.libraryId);
			}}
		/>
	);
}

/** Clashes, framed for the settings page. Nothing when there are none. */
function ClashPanel() {
	const count = useClashes().data?.length ?? 0;
	const here = useRef<HTMLDivElement>(null);
	// The sidebar's Clashes row leads here: bring the section into view and light it briefly.
	const asked = useRouterState({ select: (s) => s.location.hash === CLASHES_ANCHOR });
	useEffect(() => {
		if (asked && count > 0) {
			here.current?.scrollIntoView({ block: "start", behavior: "smooth" });
		}
	}, [asked, count]);
	if (count === 0) {
		return null;
	}
	return (
		<div
			ref={here}
			id={CLASHES_ANCHOR}
			className={cn(
				"scroll-mt-16 rounded-2xl",
				asked && "outline-2 outline-warning/50 outline-offset-4",
			)}
		>
			<FrameSection
				title="Clashes"
				description={
					<Facts label="Changes made on two computers at once. Pick which one to keep.">
						<Fact tone="warn">Edited on two computers</Fact>
						<Fact>Pick one</Fact>
					</Facts>
				}
			>
				<div className="[--diff-inset:1rem] [&_section]:border-b-0">
					<ClashList />
				</div>
			</FrameSection>
		</div>
	);
}
