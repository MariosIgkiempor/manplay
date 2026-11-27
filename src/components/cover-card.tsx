import {
	Check,
	ChevronLeft,
	ChevronRight,
	Download,
	LoaderCircle,
	Music,
	Upload,
	X,
} from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
	lookupCoverUrl,
	pathArtUrl,
	pickCoverFile,
	pickerReadImage,
	type ReleaseId,
	type TagPaths,
} from "#/lib/api.ts";
import { bumpArt, useArtVersion } from "#/lib/art-version.ts";
import {
	COVER_EXTENSIONS,
	COVER_TYPES,
	coverTypeOf,
	type DownloadStage,
	downloadStage,
	optionCaption,
} from "#/lib/cover-choice.ts";
import { useCoverSearch, useLookupCoverSet, useServices, useTagsSetCover } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** The shape of every button that sits on the picture. */
const ON_PHOTO =
	"flex h-8 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium text-xs outline-none backdrop-blur-sm transition-colors focus-visible:ring-2 focus-visible:ring-white/80 motion-reduce:transition-none [&_svg]:size-3.5 [&_svg]:shrink-0";

/** Dark glass, which reads on any cover: the colour of a button at rest. */
const GLASS = "bg-black/60 text-white hover:bg-black/80";

/** The Download button's colour in each stage, so its state shows before its words are read. */
const STAGE_COLOUR: Record<Exclude<DownloadStage, "ready">, string> = {
	idle: GLASS,
	ask: "bg-primary text-primary-foreground hover:bg-primary/85",
	searching: "bg-white/90 text-black",
	loading: "bg-white/90 text-black",
	none: "bg-warning text-black hover:bg-warning/85",
	failed: "bg-destructive text-white hover:bg-destructive/85",
};

/**
 * The cover, large, with the two ways to change it on top: upload a picture from this computer,
 * or download one found online. A picture can also be dropped on it or pasted. Either way the
 * new cover shows first, dimmed, to confirm or cancel, and undo puts the old cover back.
 */
export function CoverCard({
	paths,
	name,
	album,
	pasted,
	onDone,
}: {
	/** The song, or every song the cover goes to. */
	paths: TagPaths;
	/** What the cover belongs to, for labels. */
	name: string;
	/** The album of the one song in `paths`, when it has others: confirming asks which to cover. */
	album?: CoverAlbum | undefined;
	/** A picture pasted before the card opened, shown to confirm like an upload. */
	pasted?: Blob | null | undefined;
	/** Called once a new cover is written. */
	onDone: () => void;
}) {
	const version = useArtVersion();
	const found = useFoundCover(paths);
	const { inView, stage } = found;
	const setFile = useTagsSetCover();
	const setRelease = useLookupCoverSet();
	const [problem, setProblem] = useState<string | null>(null);
	const picked = usePickedCover(setProblem);
	const [dragging, setDragging] = useState(false);
	const busy = setFile.isPending || setRelease.isPending;

	const finish = (report: { failed: readonly { error: string }[] }) => {
		bumpArt();
		const failed = report.failed[0];
		if (failed) {
			setProblem(`${report.failed.length} not saved: ${failed.error}`);
		} else {
			onDone();
		}
	};
	const fail = (e: unknown) => setProblem(String(e));
	const applyFile = (file: Blob | null | undefined) => {
		if (file && !busy) {
			found.cancel();
			void picked.pick(file);
		}
	};
	const upload = async () => {
		const path = await pickCoverFile(COVER_EXTENSIONS);
		if (path === null) {
			return;
		}
		try {
			const image = await pickerReadImage(path);
			applyFile(new Blob([image], { type: coverTypeOf(path) ?? "" }));
		} catch (e) {
			fail(e);
		}
	};
	const confirm = (to: TagPaths) => {
		setProblem(null);
		if (picked.cover) {
			setFile.mutate({ path: to, image: picked.cover.image }, { onSuccess: finish, onError: fail });
		} else if (inView) {
			setRelease.mutate(
				{ path: to, release: inView.release },
				{ onSuccess: finish, onError: fail },
			);
		}
	};
	const cancel = () => {
		picked.clear();
		found.cancel();
	};
	const applyFileRef = useRef(applyFile);
	applyFileRef.current = applyFile;
	useEffect(() => {
		if (pasted) {
			applyFileRef.current(pasted);
		}
	}, [pasted]);
	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
			if (item) {
				e.preventDefault();
				applyFileRef.current(item.getAsFile());
			}
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
	}, []);

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		applyFile(e.dataTransfer.files[0]);
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a picture can be dropped on the cover
		<div
			className="relative size-full"
			onDragOver={(e) => {
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			<Photo src={currentCover(paths, version)} alt={`Cover of ${name}`} />
			{picked.cover && (
				<img
					src={picked.cover.url}
					alt="The cover you chose"
					draggable={false}
					className="absolute inset-0 size-full object-cover brightness-75"
				/>
			)}
			{inView && !picked.cover && (
				// The found cover arrives over the current one and shows once it has loaded.
				<img
					key={inView.release}
					src={lookupCoverUrl(inView.release)}
					alt={`Cover found online: ${optionCaption(inView)}`}
					data-hint={optionCaption(inView)}
					draggable={false}
					onLoad={() => found.arrived(inView.release)}
					onError={() => found.missing(inView.release)}
					className={cn(
						"absolute inset-0 size-full object-cover brightness-75",
						stage !== "ready" && "invisible",
					)}
				/>
			)}
			<Status problem={problem} busy={busy} dragging={dragging} />
			<div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/75 to-transparent px-3 pt-8 pb-3">
				{picked.cover || stage === "ready" ? (
					<Decide
						disabled={busy}
						count={picked.cover ? 1 : found.count}
						position={found.position}
						album={album}
						onStep={found.step}
						onConfirm={() => confirm(paths)}
						onConfirmAlbum={album ? () => confirm(album.paths) : undefined}
						onCancel={cancel}
					/>
				) : (
					<>
						<button
							type="button"
							className={cn(ON_PHOTO, GLASS, "disabled:opacity-60")}
							disabled={busy}
							data-hint="Choose a picture, or drop or paste one"
							onClick={() => void upload()}
						>
							<Upload />
							{/* Once Download has something to say, Upload gives it the room. */}
							{stage === "idle" ? "Upload" : <span className="sr-only">Upload</span>}
						</button>
						<DownloadButton
							stage={stage}
							disabled={busy}
							error={found.error}
							onPress={found.download}
						/>
					</>
				)}
			</div>
		</div>
	);
}

/** The album a song belongs to, with every song of it, for "this song or all of them". */
export interface CoverAlbum {
	name: string;
	paths: readonly string[];
}

/** A picture chosen from this computer, held to show before it is written. */
interface PickedCover {
	image: Uint8Array;
	/** Where the card shows it from. */
	url: string;
}

/** The picture the user uploaded, dropped or pasted, until they confirm or cancel it. */
function usePickedCover(onProblem: (problem: string | null) => void) {
	const [cover, setCover] = useState<PickedCover | null>(null);
	// The browser keeps a shown picture in memory until its address is given back.
	useEffect(() => () => (cover ? URL.revokeObjectURL(cover.url) : undefined), [cover]);
	return {
		cover,
		pick: async (file: Blob) => {
			if (!COVER_TYPES.includes(file.type)) {
				onProblem("Use a JPEG or PNG picture");
				return;
			}
			onProblem(null);
			const image = new Uint8Array(await file.arrayBuffer());
			setCover({ image, url: URL.createObjectURL(file) });
		},
		clear: () => setCover(null),
	};
}

/**
 * Finding a cover online for the card: the search, which of the found covers is in view, and
 * whether its picture has arrived.
 */
function useFoundCover(paths: TagPaths) {
	const services = useServices();
	const allowed = services.isEnabled("lookup", false);
	const [asked, setAsked] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const search = useCoverSearch(paths, attempt, asked && allowed);
	// Releases whose picture did not load have no cover, so they are passed over.
	const [without, setWithout] = useState<ReadonlySet<ReleaseId>>(new Set());
	const [index, setIndex] = useState(0);
	const [loaded, setLoaded] = useState<ReleaseId | null>(null);

	const candidates = search.data?.options.filter((o) => !without.has(o.release)) ?? null;
	const count = candidates?.length ?? 0;
	const position = count > 0 ? index % count : 0;
	const inView = asked ? candidates?.[position] : undefined;
	const stage = downloadStage({
		asked,
		allowed,
		searching: search.isFetching,
		failed: search.isError,
		candidates: candidates ? count : null,
		loaded: inView !== undefined && loaded === inView.release,
	});
	return {
		stage,
		inView,
		count,
		position,
		error: search.isError ? String(search.error) : null,
		arrived: setLoaded,
		missing: (release: ReleaseId) => setWithout((s) => new Set(s).add(release)),
		/** Moves to the next or previous found cover, round the ends. */
		step: (by: 1 | -1) => setIndex((i) => i + by + count),
		cancel: () => {
			setAsked(false);
			setIndex(0);
		},
		/** The Download button was pressed: allow, search, or search again, by the stage. */
		download: () => {
			if (stage === "ask") {
				services.setEnabled("lookup", true);
			} else if (stage === "none" || stage === "failed") {
				setWithout(new Set());
				setIndex(0);
				setAttempt((n) => n + 1);
			}
			setAsked(true);
		},
	};
}

/** What the Download button says in each stage; a failed search says why instead. */
const STAGE_WORDS: Record<Exclude<DownloadStage, "ready">, string> = {
	idle: "Download",
	ask: "Search online?",
	searching: "Searching…",
	loading: "Downloading…",
	none: "No covers found",
	failed: "Search failed",
};

const STAGE_HINT: Record<Exclude<DownloadStage, "ready">, string> = {
	idle: "Find this album's cover online",
	ask: "Sends the album and artist to MusicBrainz (and Discogs, if saved) and turns tag lookup on. Press to continue.",
	searching: "Looking for this album",
	loading: "Fetching the cover",
	none: "No release of this album has a cover online. Press to search again.",
	failed: "Press to try again",
};

/** Finds a cover online. Its words and colour say where the search stands. */
function DownloadButton({
	stage,
	disabled,
	error,
	onPress,
}: {
	stage: Exclude<DownloadStage, "ready">;
	disabled: boolean;
	/** Why the search failed, to say in place of the button's usual words. */
	error: string | null;
	onPress: () => void;
}) {
	const working = stage === "searching" || stage === "loading";
	return (
		<button
			type="button"
			className={cn(ON_PHOTO, STAGE_COLOUR[stage], "min-w-0 disabled:opacity-60")}
			disabled={disabled || working}
			aria-busy={working}
			data-hint={stage === "failed" && error ? `${error} Press to try again.` : STAGE_HINT[stage]}
			onClick={onPress}
		>
			{working ? <LoaderCircle className="animate-spin" /> : <Download />}
			<span className="truncate">{stage === "failed" && error ? error : STAGE_WORDS[stage]}</span>
		</button>
	);
}

/**
 * A found cover is showing: use it or not. With several found, the arrows step through them.
 */
function Decide({
	disabled,
	count,
	position,
	album,
	onStep,
	onConfirm,
	onConfirmAlbum,
	onCancel,
}: {
	disabled: boolean;
	/** How many covers were found. */
	count: number;
	/** Which of them is showing, from 0. */
	position: number;
	/** Offered as well: the cover for the song's whole album. */
	album?: CoverAlbum | undefined;
	onStep: (by: 1 | -1) => void;
	onConfirm: () => void;
	onConfirmAlbum?: (() => void) | undefined;
	onCancel: () => void;
}) {
	const round = cn(ON_PHOTO, GLASS, "w-8 justify-center px-0 disabled:opacity-60");
	const step = (by: 1 | -1) =>
		count > 1 && (
			<button
				type="button"
				className={cn(round, "shrink-0")}
				disabled={disabled}
				aria-label={by < 0 ? "Previous cover" : "Next cover"}
				data-hint={`Cover ${position + 1} of ${count}`}
				onClick={() => onStep(by)}
			>
				{by < 0 ? <ChevronLeft /> : <ChevronRight />}
			</button>
		);
	const accept = cn(
		ON_PHOTO,
		"bg-primary text-primary-foreground hover:bg-primary/85 disabled:opacity-60",
	);
	const cancel = (
		<button
			type="button"
			className={cn(ON_PHOTO, GLASS, "disabled:opacity-60")}
			disabled={disabled}
			onClick={onCancel}
		>
			<X /> Cancel
		</button>
	);
	if (album && onConfirmAlbum) {
		// Two choices do not fit beside the arrows: browsing on one line, choosing on the next.
		return (
			<div className="flex flex-col items-center gap-2">
				<div className="flex items-center gap-2">
					{step(-1)}
					{cancel}
					{step(1)}
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						className={accept}
						disabled={disabled}
						data-hint="Only this song gets the cover"
						onClick={onConfirm}
					>
						<Check /> This song
					</button>
					<button
						type="button"
						className={accept}
						disabled={disabled}
						data-hint={`Every song on ${album.name} gets the cover, and its folder gets it as cover.jpg`}
						onClick={onConfirmAlbum}
					>
						<Check /> All {album.paths.length}
					</button>
				</div>
			</div>
		);
	}
	return (
		<>
			{step(-1)}
			<button type="button" className={accept} disabled={disabled} onClick={onConfirm}>
				<Check /> Confirm
			</button>
			{cancel}
			{step(1)}
		</>
	);
}

/** Where the cover as it is now loads from: the first song's. */
function currentCover(paths: TagPaths, version: number): string | null {
	const first = typeof paths === "string" ? paths : paths[0];
	return first ? `${pathArtUrl(first)}?v=${version}` : null;
}

function Banner({ children }: { children: ReactNode }) {
	return (
		<p
			role="alert"
			className="absolute inset-x-0 top-0 bg-destructive px-3 py-1.5 text-white text-xs"
		>
			{children}
		</p>
	);
}

/** What is happening to the card right now, laid over the picture. */
function Status({
	problem,
	busy,
	dragging,
}: {
	problem: string | null;
	busy: boolean;
	dragging: boolean;
}) {
	return (
		<>
			{problem && <Banner>{problem}</Banner>}
			{(dragging || busy) && (
				<div className="absolute inset-0 grid place-items-center bg-black/60 text-sm text-white">
					{busy ? <LoaderCircle className="size-6 animate-spin" /> : "Drop to use this picture"}
				</div>
			)}
		</>
	);
}

/** The picture filling the card, or a placeholder when there is none or it cannot be shown. */
function Photo({ src, alt }: { src: string | null; alt: string }) {
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	if (src === null || failedSrc === src) {
		return (
			<span className="grid size-full place-items-center bg-muted text-muted-foreground">
				<Music className="size-16" />
			</span>
		);
	}
	return (
		<img
			src={src}
			alt={alt}
			draggable={false}
			onError={() => setFailedSrc(src)}
			className="size-full object-cover"
		/>
	);
}
