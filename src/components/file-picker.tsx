import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronRight,
	Download,
	File,
	FileText,
	Folder,
	FolderPlus,
	HardDrive,
	House,
	Image,
	type LucideIcon,
	Monitor,
	Music,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	type FsEntry,
	type PickerListing,
	type PickerPlace,
	pickerList,
	pickerMakeDir,
	pickerPlaces,
} from "#/lib/api.ts";
import { coverTypeOf } from "#/lib/cover-choice.ts";
import { useExitGhost } from "#/lib/exit-ghost.ts";
import {
	answerPick,
	isUsable,
	type PickPurpose,
	type PickRequest,
	pickTarget,
	rememberedFolder,
	rememberFolder,
	saveDecision,
	usePendingPick,
	visibleEntries,
} from "#/lib/file-picker.ts";
import { formatBytes } from "#/lib/format.ts";
import { baseName, isAudioName, isInside, joinPath } from "#/lib/fs-path.ts";
import { DIALOG_BACKDROP, DIALOG_FRAME, WELL } from "#/lib/page-layout.ts";
import { cn } from "#/lib/utils.ts";

/** How many folders of the way down the picker names; the ones above fold into one "…". */
const SHOWN_CRUMBS = 4;

const PLACE_ICONS: Record<PickerPlace["kind"], LucideIcon> = {
	home: House,
	desktop: Monitor,
	documents: FileText,
	downloads: Download,
	music: Music,
	volume: HardDrive,
};

const ROW =
	"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** Shows the app's file picker whenever something asks for a path. Mounted once, in the shell. */
export function FilePickerHost() {
	const request = usePendingPick();
	return request && <FilePicker request={request} onDone={answerPick} />;
}

function entryIcon(entry: FsEntry): LucideIcon {
	if (entry.isDir) {
		return Folder;
	}
	if (isAudioName(entry.name)) {
		return Music;
	}
	return coverTypeOf(entry.name) ? Image : File;
}

/** The place the folder is in: the deepest one that holds it. */
function currentPlace(places: readonly PickerPlace[], folder: string | null): string | null {
	if (folder === null) {
		return null;
	}
	return places
		.filter((place) => place.path === folder || isInside(folder, place.path))
		.reduce<string | null>(
			(deepest, place) =>
				deepest === null || place.path.length > deepest.length ? place.path : deepest,
			null,
		);
}

/**
 * The folder the picker is in: where this kind of picker was last used, else the home folder,
 * until the user walks somewhere.
 */
function usePickerFolder(purpose: PickPurpose) {
	const places = useQuery({ queryKey: ["picker-places"], queryFn: pickerPlaces, retry: false });
	const home = places.data?.[0]?.path ?? null;
	const remembered = useRef(rememberedFolder(purpose));
	const [walkedTo, setWalkedTo] = useState<string | null>(remembered.current);
	const folder = walkedTo ?? home;
	const listing = useQuery({
		queryKey: ["picker-list", folder],
		queryFn: () => pickerList(folder ?? ""),
		enabled: folder !== null,
		retry: false,
	});
	// The folder used last time may be gone (a drive unplugged); start from home instead.
	useEffect(() => {
		if (listing.isError && home !== null && folder === remembered.current && folder !== home) {
			remembered.current = null;
			setWalkedTo(home);
		}
	}, [listing.isError, home, folder]);
	return { places, folder, listing, walkTo: setWalkedTo };
}

/** Runs `onEscape` on the Escape key, before anything under the picker can act on it. */
function useEscapeKey(onEscape: () => void) {
	const latest = useRef(onEscape);
	latest.current = onEscape;
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				latest.current();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);
}

/** What the user has chosen so far in the open folder, and what each control does with it. */
function usePickerChoice({
	request,
	folder,
	entries,
	walkTo,
	onDone,
}: {
	request: PickRequest;
	folder: string | null;
	/** What the open folder holds; null until it has been read. */
	entries: readonly FsEntry[] | null;
	walkTo: (path: string) => void;
	onDone: (path: string | null) => void;
}) {
	const [filter, setFilter] = useState("");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [typedName, setTypedName] = useState(request.kind === "save" ? request.defaultName : "");
	const [replaceAsked, setReplaceAsked] = useState(false);
	const [namingFolder, setNamingFolder] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	const go = (path: string) => {
		walkTo(path);
		setFilter("");
		setSelectedFile(null);
		setReplaceAsked(false);
		setNamingFolder(false);
		setProblem(null);
	};
	const typeName = (name: string) => {
		setTypedName(name);
		setReplaceAsked(false);
		setProblem(null);
	};
	const finish = (path: string) => {
		if (folder !== null) {
			rememberFolder(request.purpose, folder);
		}
		onDone(path);
	};
	const save = (extension: string, into: string, holding: readonly FsEntry[]) => {
		const decision = saveDecision(typedName, extension, holding, replaceAsked);
		setProblem(decision.kind === "problem" ? decision.problem : null);
		if (decision.kind === "askReplace") {
			setReplaceAsked(true);
		} else if (decision.kind === "save") {
			finish(joinPath(into, decision.name));
		}
	};

	const target = folder === null ? null : pickTarget(request, folder, selectedFile, typedName);
	return {
		filter,
		setFilter,
		selectedFile,
		typedName,
		typeName,
		namingFolder,
		setNamingFolder,
		problem,
		setProblem,
		go,
		target,
		/** The file a save would replace, once the user has been asked about it. */
		replacing: replaceAsked && target !== null ? baseName(target) : null,
		confirm: () => {
			if (folder === null || entries === null) {
				return;
			}
			if (request.kind === "save") {
				save(request.extension, folder, entries);
			} else if (target !== null) {
				finish(target);
			}
		},
		activate: (entry: FsEntry) => {
			if (folder === null) {
				return;
			}
			if (entry.isDir) {
				go(joinPath(folder, entry.name));
			} else if (request.kind === "file") {
				setSelectedFile(entry.name);
			} else {
				typeName(entry.name);
			}
		},
		choose: (entry: FsEntry) => folder !== null && finish(joinPath(folder, entry.name)),
	};
}

function FilePicker({
	request,
	onDone,
}: {
	request: PickRequest;
	onDone: (path: string | null) => void;
}) {
	const overlay = useExitGhost();
	const { places, folder, listing, walkTo } = usePickerFolder(request.purpose);
	const entries = listing.data?.entries ?? null;
	const choice = usePickerChoice({ request, folder, entries, walkTo, onDone });
	const cancel = () => onDone(null);
	useEscapeKey(choice.namingFolder ? () => choice.setNamingFolder(false) : cancel);

	return (
		<div ref={overlay} className="fixed inset-0 z-[60] flex items-center justify-center">
			<div aria-hidden="true" onMouseDown={cancel} className={DIALOG_BACKDROP} />
			<div
				role="dialog"
				data-exit
				aria-modal="true"
				aria-label={request.title}
				className={cn(
					DIALOG_FRAME,
					"flex h-[34rem] max-h-[calc(100%-2rem)] w-[46rem] max-w-[calc(100%-2rem)] flex-col gap-2 p-3",
				)}
			>
				<div className="px-1 pt-1 font-medium text-sm">{request.title}</div>
				<div className="flex items-center gap-2 px-1">
					<Crumbs listing={listing.data} onGo={choice.go} />
					<Input
						aria-label="Filter this folder"
						placeholder="Filter"
						value={choice.filter}
						onChange={(e) => choice.setFilter(e.target.value)}
						autoFocus={request.kind !== "save"}
						className="ml-auto w-40 shrink-0"
					/>
				</div>
				<div className="flex min-h-0 flex-1 gap-2">
					<Places
						places={places.data ?? []}
						current={currentPlace(places.data ?? [], folder)}
						onGo={choice.go}
					/>
					<div className={cn(WELL, "min-w-0 flex-1 overflow-y-auto p-1")}>
						{choice.namingFolder && folder !== null && (
							<NewFolderRow parent={folder} onMade={choice.go} onProblem={choice.setProblem} />
						)}
						<Entries
							listing={listing}
							waiting={folder === null && !places.isError}
							shown={visibleEntries(entries ?? [], request, choice.filter)}
							filtered={choice.filter.trim() !== ""}
							request={request}
							selectedFile={choice.selectedFile}
							onActivate={choice.activate}
							onChoose={choice.choose}
						/>
					</div>
				</div>
				<Notices
					problems={[places.isError ? String(places.error) : null, choice.problem]}
					replacing={choice.replacing}
				/>
				{request.kind === "save" && (
					<SaveName value={choice.typedName} onChange={choice.typeName} onEnter={choice.confirm} />
				)}
				<Footer
					canMakeFolder={request.kind !== "file"}
					makeFolderDisabled={entries === null || choice.namingFolder}
					onMakeFolder={() => {
						choice.setProblem(null);
						choice.setNamingFolder(true);
					}}
					target={entries === null ? null : choice.target}
					confirmLabel={choice.replacing ? "Replace" : request.confirmLabel}
					destructive={choice.replacing !== null}
					onConfirm={choice.confirm}
					onCancel={cancel}
				/>
			</div>
		</div>
	);
}

/** What went wrong, and the warning before a save replaces a file. */
function Notices({
	problems,
	replacing,
}: {
	problems: readonly (string | null)[];
	replacing: string | null;
}) {
	return (
		<>
			{problems.map((problem) => problem && <ErrorLine key={problem}>{problem}</ErrorLine>)}
			{replacing && (
				<div role="alert" className="px-1 text-sm text-warning">
					“{replacing}” is already in this folder. Saving here replaces it.
				</div>
			)}
		</>
	);
}

/** The bottom row: New folder, the path that would be chosen, and the two answers. */
function Footer({
	canMakeFolder,
	makeFolderDisabled,
	onMakeFolder,
	target,
	confirmLabel,
	destructive,
	onConfirm,
	onCancel,
}: {
	canMakeFolder: boolean;
	makeFolderDisabled: boolean;
	onMakeFolder: () => void;
	/** The path the confirm button hands back; null while there is nothing to choose. */
	target: string | null;
	confirmLabel: string;
	destructive: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="flex items-center gap-2 px-1 pb-1">
			{canMakeFolder && (
				<Button variant="ghost" disabled={makeFolderDisabled} onClick={onMakeFolder}>
					<FolderPlus />
					New folder
				</Button>
			)}
			<div
				className="min-w-0 flex-1 truncate text-right text-muted-foreground text-xs"
				data-hint={target ?? undefined}
			>
				{target}
			</div>
			<Button variant="ghost" onClick={onCancel}>
				Cancel
			</Button>
			<Button
				variant={destructive ? "destructive" : "default"}
				disabled={target === null}
				onClick={onConfirm}
			>
				{confirmLabel}
			</Button>
		</div>
	);
}

/** A row at the top of the folder to name a new folder in it; the picker moves into it once made. */
function NewFolderRow({
	parent,
	onMade,
	onProblem,
}: {
	parent: string;
	onMade: (path: string) => void;
	onProblem: (problem: string | null) => void;
}) {
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const make = useMutation({
		mutationFn: () => pickerMakeDir(parent, name),
		onSuccess: async (made) => {
			await queryClient.invalidateQueries({ queryKey: ["picker-list", parent] });
			onMade(made);
		},
		onError: (e) => onProblem(String(e)),
	});
	return (
		<form
			className="flex items-center gap-2 px-1 py-1"
			onSubmit={(e) => {
				e.preventDefault();
				onProblem(null);
				make.mutate();
			}}
		>
			<Folder className="size-4 shrink-0 text-muted-foreground" />
			<Input
				aria-label="Name of the new folder"
				placeholder="New folder"
				value={name}
				onChange={(e) => setName(e.target.value)}
				autoFocus
			/>
			<Button type="submit" size="sm" disabled={name.trim() === "" || make.isPending}>
				Create
			</Button>
		</form>
	);
}

/** The name to save under; opens with the part before the extension selected, ready to retype. */
function SaveName({
	value,
	onChange,
	onEnter,
}: {
	value: string;
	onChange: (name: string) => void;
	onEnter: () => void;
}) {
	const id = useId();
	return (
		<div className="flex items-center gap-2 px-1">
			<label htmlFor={id} className="shrink-0 text-muted-foreground text-sm">
				Save as
			</label>
			<Input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => e.key === "Enter" && onEnter()}
				onFocus={(e) => {
					const dot = e.target.value.lastIndexOf(".");
					e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
				}}
				autoFocus
			/>
		</div>
	);
}

/** The way down to the open folder; each step is a way back up. */
function Crumbs({
	listing,
	onGo,
}: {
	listing: PickerListing | undefined;
	onGo: (path: string) => void;
}) {
	const crumbs = listing?.crumbs ?? [];
	const folded = crumbs.at(-(SHOWN_CRUMBS + 1));
	return (
		<nav aria-label="Folder path" className="flex min-w-0 items-center gap-1 text-sm">
			{folded && (
				<>
					<button
						type="button"
						data-hint={folded.path}
						aria-label={`Up to ${folded.name}`}
						className="shrink-0 rounded px-1 text-muted-foreground hover:bg-muted"
						onClick={() => onGo(folded.path)}
					>
						…
					</button>
					<ChevronRight className="size-3 shrink-0 text-muted-foreground" />
				</>
			)}
			{crumbs.slice(-SHOWN_CRUMBS).map((crumb, i, tail) => {
				const last = i === tail.length - 1;
				return (
					<span key={crumb.path} className="flex min-w-0 items-center gap-1">
						<button
							type="button"
							aria-current={last ? "location" : undefined}
							className={cn(
								"truncate rounded px-1 hover:bg-muted",
								last ? "font-medium" : "text-muted-foreground",
							)}
							onClick={() => onGo(crumb.path)}
						>
							{crumb.name}
						</button>
						{!last && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
					</span>
				);
			})}
		</nav>
	);
}

function Places({
	places,
	current,
	onGo,
}: {
	places: readonly PickerPlace[];
	current: string | null;
	onGo: (path: string) => void;
}) {
	const groups = [
		{ label: "Places", places: places.filter((place) => place.kind !== "volume") },
		{ label: "Disks", places: places.filter((place) => place.kind === "volume") },
	].filter((group) => group.places.length > 0);
	return (
		<nav aria-label="Places" className="w-44 shrink-0 space-y-3 overflow-y-auto py-1">
			{groups.map((group) => (
				<div key={group.label}>
					<div className="px-2 pb-1 text-muted-foreground text-xs">{group.label}</div>
					{group.places.map((place) => {
						const Icon = PLACE_ICONS[place.kind];
						return (
							<button
								key={place.path}
								type="button"
								aria-current={place.path === current ? "true" : undefined}
								className={cn(ROW, place.path === current && "bg-muted")}
								onClick={() => onGo(place.path)}
							>
								<Icon />
								<span className="truncate">{place.name}</span>
							</button>
						);
					})}
				</div>
			))}
		</nav>
	);
}

/** Moves focus to the next or previous row with the arrow keys. */
function stepRow(e: KeyboardEvent<HTMLUListElement>) {
	const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
	if (step === 0) {
		return;
	}
	e.preventDefault();
	const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
	const at = rows.indexOf(document.activeElement as HTMLButtonElement);
	rows[Math.min(Math.max(at + step, 0), rows.length - 1)]?.focus();
}

function Entries({
	listing,
	waiting,
	shown,
	filtered,
	request,
	selectedFile,
	onActivate,
	onChoose,
}: {
	listing: { isPending: boolean; isError: boolean; error: unknown };
	/** The places are still loading, so there is no folder to list yet. */
	waiting: boolean;
	shown: readonly FsEntry[];
	filtered: boolean;
	request: PickRequest;
	selectedFile: string | null;
	onActivate: (entry: FsEntry) => void;
	onChoose: (entry: FsEntry) => void;
}) {
	if (listing.isError) {
		return (
			<div className="p-2">
				<ErrorLine>{String(listing.error)}</ErrorLine>
			</div>
		);
	}
	if (waiting || listing.isPending) {
		return null;
	}
	if (shown.length === 0) {
		return (
			<div className="px-2 py-1.5 text-muted-foreground text-sm">
				{filtered ? "Nothing here matches the filter." : "This folder is empty."}
			</div>
		);
	}
	return (
		<ul onKeyDown={stepRow}>
			{shown.map((entry) => {
				const Icon = entryIcon(entry);
				const selected = !entry.isDir && entry.name === selectedFile;
				return (
					<li key={entry.name}>
						<button
							type="button"
							disabled={!isUsable(entry, request)}
							aria-pressed={request.kind === "file" && !entry.isDir ? selected : undefined}
							className={cn(ROW, selected && "bg-primary/15 hover:bg-primary/20")}
							onClick={() => onActivate(entry)}
							onDoubleClick={() => request.kind === "file" && !entry.isDir && onChoose(entry)}
						>
							<Icon />
							<span className="min-w-0 flex-1 truncate">{entry.name}</span>
							{entry.isDir ? (
								<ChevronRight />
							) : (
								<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
									{formatBytes(entry.size)}
								</span>
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
}
