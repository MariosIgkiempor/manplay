import { MenuItemIndicator, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@ui-sdk/react/menu";
import { Check, ChevronsUpDown, Globe, Music, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { MenuPopup, MenuRoot } from "#/components/ui/popup.tsx";
import { PanelBarActions, useHasPanelBar } from "#/context/panel-bar.tsx";
import { type LookupCandidate, lookupCoverUrl, type ReleaseId } from "#/lib/api.ts";
import {
	type CoverSuggestion,
	chosenCandidate,
	isMatched,
	type MatchedSong,
	type Suggestion,
} from "#/lib/tag-lookup.ts";
import { labelOf } from "#/lib/tag-preview.ts";
import type { TagSuggestions } from "#/lib/use-tag-suggestions.ts";
import { cn } from "#/lib/utils.ts";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The lookup's place at the top of the tag editor. Before a lookup it is one button (in the side
 * panel's top bar when there is one); after, it
 * says what was found and holds what has no tag row to sit beside: the cover, the tags that
 * differ from song to song, and the songs that were not found.
 */
export function TagLookupStrip({ found }: { found: TagSuggestions }) {
	const inBar = useHasPanelBar();
	if (found.stage === "idle") {
		const button = (
			<Button variant="ghost" size="sm" onClick={found.start}>
				<Globe /> Look up tags
			</Button>
		);
		// In the side panel the button sits in its top bar, so it costs no row of its own.
		return inBar ? (
			<PanelBarActions>{button}</PanelBarActions>
		) : (
			<div className="flex justify-end border-b px-3 py-1.5">{button}</div>
		);
	}
	return (
		<section
			aria-label="Tag lookup"
			className="space-y-2.5 border-b bg-muted/30 px-3 py-2.5 text-xs"
		>
			{found.stage === "consent" && <Consent found={found} />}
			{found.stage === "running" && <Running found={found} />}
			{found.stage === "failed" && (
				<div className="flex items-start gap-2">
					<ErrorLine className="min-w-0 flex-1">{found.problem}</ErrorLine>
					<Button variant="outline" size="xs" onClick={found.searchAgain}>
						Try again
					</Button>
					<Close found={found} label="Close" />
				</div>
			)}
			{found.stage === "results" && <Results found={found} />}
		</section>
	);
}

function Close({ found, label }: { found: TagSuggestions; label: string }) {
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label={label}
			data-hint={label}
			onClick={found.dismiss}
		>
			<X />
		</Button>
	);
}

/** Shown until lookups are switched on: what is sent, and where. */
function Consent({ found }: { found: TagSuggestions }) {
	return (
		<div className="space-y-2">
			<Facts label="A lookup sends the song's title and first artist to MusicBrainz, and to Discogs if you saved a token. Covers use the album name. Nothing else leaves this computer. Switch it off in Settings.">
				<Fact tone="sent">Title</Fact>
				<Fact tone="sent">First artist</Fact>
				<Fact tone="sent">Album, for covers</Fact>
				<Fact>MusicBrainz · Discogs with a token</Fact>
				<Fact tone="kept">Nothing else</Fact>
				<Fact>Only songs you choose</Fact>
			</Facts>
			<div className="flex gap-2">
				<Button size="sm" onClick={found.allow}>
					Turn on and look up
				</Button>
				<Button variant="ghost" size="sm" onClick={found.dismiss}>
					Not now
				</Button>
			</div>
		</div>
	);
}

function Running({ found }: { found: TagSuggestions }) {
	const { progress } = found;
	return (
		<div className="space-y-1.5" aria-busy="true">
			<div className="flex items-center gap-2">
				<p className="min-w-0 flex-1 text-sm">
					{progress && progress.total > 1
						? `Looking up song ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
						: "Looking up…"}
				</p>
				<Button variant="outline" size="xs" onClick={found.dismiss}>
					Stop
				</Button>
			</div>
			<progress
				className="h-1 w-full accent-primary"
				value={progress?.done ?? 0}
				max={progress?.total || 1}
			/>
		</div>
	);
}

function Results({ found }: { found: TagSuggestions }) {
	const left = found.inline.size + found.apart.length + found.covers.length;
	return (
		<>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<div className="min-w-0 basis-full text-sm">
					<Headline found={found} left={left} />
				</div>
				{left > 0 && (
					<>
						<Button size="xs" onClick={found.takeAll} disabled={found.writing}>
							Use all
						</Button>
						<Button
							variant="outline"
							size="xs"
							data-hint="Only the tags and covers these songs do not have yet"
							onClick={found.takeFills}
							disabled={found.writing}
						>
							Only what is missing
						</Button>
					</>
				)}
				<Button
					variant="ghost"
					size="icon-xs"
					className="ml-auto"
					aria-label="Search again"
					data-hint="Search again"
					onClick={found.searchAgain}
				>
					<RefreshCw />
				</Button>
				<Close found={found} label="Put the results away" />
			</div>
			<LeftOut found={found} />
			{found.covers.map((cover) => (
				<CoverOffer
					key={`${cover.release}:${cover.replaces}`}
					cover={cover}
					group={found.songs.length > 1}
					disabled={found.writing}
					onTake={() => found.takeCover(cover)}
				/>
			))}
			{found.apart.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-muted-foreground">
						{found.songs.length > 1 ? "A value for each song" : "Also found"}
					</span>
					{found.apart.map((suggestion) => (
						<ApartChip
							key={suggestion.field}
							suggestion={suggestion}
							disabled={found.writing}
							onTake={() => found.take(suggestion)}
						/>
					))}
				</div>
			)}
			<Unmatched found={found} />
			{found.problem && <ErrorLine>{found.problem}</ErrorLine>}
		</>
	);
}

/** What the lookup found, in a line: the match for one song, a count for several. */
function Headline({ found, left }: { found: TagSuggestions; left: number }) {
	const only = found.songs.length === 1 ? found.songs[0] : undefined;
	if (only && isMatched(only)) {
		const candidate = chosenCandidate(only, found.using);
		return (
			<span className="flex min-w-0 items-center gap-2">
				{candidate && <Confidence candidate={candidate} />}
				<MatchChoice song={only} found={found} />
				{left === 0 && <span className="truncate text-muted-foreground">Nothing left to use</span>}
			</span>
		);
	}
	const { tally } = found;
	if (!tally || tally.used === 0) {
		return <span>No sure match found</span>;
	}
	return (
		<span>
			Found tags for {tally.used} of {count(tally.songs, "song", "songs")}
			{left === 0 && <span className="text-muted-foreground">, nothing left to use</span>}
		</span>
	);
}

/** Matches that are not sure are left out until asked for. */
function LeftOut({ found }: { found: TagSuggestions }) {
	const leftOut = found.tally?.leftOut ?? 0;
	if (leftOut === 0 && !found.using.includeUnsure) {
		return null;
	}
	return (
		<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
			{found.using.includeUnsure
				? "Unsure matches are included: check their values before using them."
				: `${count(leftOut, "unsure match is", "unsure matches are")} left out.`}
			<button
				type="button"
				className="rounded-sm text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
				onClick={() => found.includeUnsure(!found.using.includeUnsure)}
			>
				{found.using.includeUnsure ? "Leave them out" : "Include them"}
			</button>
		</p>
	);
}

function Unmatched({ found }: { found: TagSuggestions }) {
	const unmatched = found.tally?.unmatched ?? [];
	if (unmatched.length === 0) {
		return null;
	}
	if (found.songs.length === 1) {
		return <p className="text-muted-foreground">{unmatched[0]?.reason}</p>;
	}
	return (
		<details>
			<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
				{count(unmatched.length, "song", "songs")} without a match
			</summary>
			<ul className="mt-1.5 space-y-1">
				{unmatched.map(({ path, reason }) => (
					<li key={path} className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate" data-hint={path}>
							{fileName(path)}
						</span>
						<span className="shrink-0 text-muted-foreground">{reason}</span>
					</li>
				))}
			</ul>
		</details>
	);
}

/** The colours of a suggestion: green when it only fills what is empty, orange when it replaces. */
function suggestionTone(fills: boolean): string {
	return fills
		? "border-success/50 bg-success/5 text-success hover:border-success hover:bg-success/15"
		: "border-warning/50 bg-warning/5 text-warning hover:border-warning hover:bg-warning/15";
}

const GHOST =
	"inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed px-1.5 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 motion-reduce:transition-none";

/**
 * A found value shown beside its tag as a dashed pill, not yet written; pressing it writes it.
 * `group` says the editor shows several songs, so the pill says how many it is for.
 */
export function SuggestionPill({
	suggestion,
	group,
	disabled,
	onTake,
}: {
	suggestion: Suggestion;
	group: boolean;
	disabled: boolean;
	onTake: () => void;
}) {
	const label = labelOf(suggestion.field);
	const olds = [...new Set(suggestion.changes.flatMap((c) => (c.from === null ? [] : [c.from])))];
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onTake}
			aria-label={`Use ${suggestion.value} for ${label}`}
			data-hint={olds.length > 0 ? `Found online. Replaces ${olds.join(", ")}` : "Found online"}
			className={cn(GHOST, suggestionTone(suggestion.fills))}
		>
			<span className="truncate">{suggestion.value}</span>
			{group && (
				<span className="shrink-0 opacity-70">
					{count(suggestion.changes.length, "song", "songs")}
				</span>
			)}
			<span className="shrink-0 font-medium">Use</span>
		</button>
	);
}

/** A tag with a value per song, or one the editor has no row for: its name and how many songs. */
function ApartChip({
	suggestion,
	disabled,
	onTake,
}: {
	suggestion: Suggestion;
	disabled: boolean;
	onTake: () => void;
}) {
	const values = suggestion.changes.map((c) => `${fileName(c.path)}: ${c.to}`).join("\n");
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onTake}
			data-hint={values}
			aria-label={`Use the found ${labelOf(suggestion.field)} for ${count(suggestion.changes.length, "song", "songs")}`}
			className={cn(GHOST, suggestionTone(suggestion.fills))}
		>
			<span className="truncate">
				{labelOf(suggestion.field)}
				{suggestion.value !== null && `: ${suggestion.value}`}
			</span>
			{suggestion.value === null && (
				<span className="shrink-0 opacity-70">
					{count(suggestion.changes.length, "song", "songs")}
				</span>
			)}
			<span className="shrink-0 font-medium">Use</span>
		</button>
	);
}

/** A found cover, small, with what taking it would do. */
function CoverOffer({
	cover,
	group,
	disabled,
	onTake,
}: {
	cover: CoverSuggestion;
	group: boolean;
	disabled: boolean;
	onTake: () => void;
}) {
	const songs = group ? ` for ${count(cover.paths.length, "song", "songs")}` : "";
	return (
		<div className="flex items-center gap-2.5">
			<FoundCover release={cover.release} />
			<p className="min-w-0 flex-1">
				{cover.replaces ? `A cover to replace the one there${songs}` : `A cover${songs}`}
			</p>
			<button
				type="button"
				disabled={disabled}
				onClick={onTake}
				className={cn(GHOST, suggestionTone(!cover.replaces))}
			>
				<span className="font-medium">Use</span>
			</button>
		</div>
	);
}

function FoundCover({ release }: { release: ReleaseId }) {
	const [failed, setFailed] = useState(false);
	const box = "size-10 shrink-0 rounded-md bg-muted";
	return failed ? (
		<span className={cn(box, "grid place-items-center text-muted-foreground")}>
			<Music className="size-4" />
		</span>
	) : (
		<img
			src={lookupCoverUrl(release)}
			alt="The cover that was found"
			loading="lazy"
			draggable={false}
			onError={() => setFailed(true)}
			className={cn(box, "object-cover ring-1 ring-foreground/10")}
		/>
	);
}

function Confidence({ candidate }: { candidate: LookupCandidate }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-md px-1.5 py-0.5 text-xs tabular-nums",
				candidate.likely ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
			)}
			data-hint={
				candidate.likely
					? "Title, artist and length agree"
					: "Not sure this is the same recording: check before using"
			}
		>
			{candidate.likely ? "Match" : "Unsure"} {candidate.confidence}%
		</span>
	);
}

/** A match by what sets it apart from the song's other matches: its release. */
function releaseOf(candidate: LookupCandidate): string {
	const { album, year } = candidate.fields;
	return [album ?? "No album", year].filter(Boolean).join(", ");
}

/** A match by the song it is: its title and who it is by. */
function songOf(candidate: LookupCandidate): string {
	const { title, artist } = candidate.fields;
	return [title, artist].filter(Boolean).join(" by ");
}

/**
 * The match in use for one song. With more than one to choose from it is a button that opens
 * the others, each with how sure it is.
 */
function MatchChoice({ song, found }: { song: MatchedSong; found: TagSuggestions }) {
	const { candidates } = song.outcome;
	const chosen = found.using.chosen.get(song.path) ?? 0;
	const current = candidates[chosen];
	if (!current) {
		return null;
	}
	if (candidates.length < 2) {
		return <span className="truncate">{releaseOf(current)}</span>;
	}
	return (
		<MenuRoot>
			<MenuTrigger
				aria-label={`Match: ${releaseOf(current)}`}
				data-hint="Choose another match"
				className="flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-input bg-transparent pr-1.5 pl-2 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[open]:bg-muted/50 motion-reduce:transition-none dark:bg-input/30"
			>
				<span className="min-w-0 flex-1 truncate text-left">{releaseOf(current)}</span>
				<span className="shrink-0 text-muted-foreground tabular-nums">
					{chosen + 1} of {candidates.length}
				</span>
				<ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
			</MenuTrigger>
			<MenuPopup
				sideOffset={4}
				align="start"
				className="card-surface w-80 max-w-[calc(100vw-2rem)] p-1 outline-none"
			>
				<MenuRadioGroup
					value={String(chosen)}
					onValueChange={(index: string) => found.choose(song.path, Number(index))}
				>
					{candidates.map((candidate, index) => (
						<MenuRadioItem
							key={`${candidate.recording}:${candidate.release ?? ""}`}
							value={String(index)}
							closeOnSelect
							className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-muted"
						>
							<span className="flex size-3.5 shrink-0 items-center justify-center text-primary">
								<MenuItemIndicator>
									<Check className="size-3.5" />
								</MenuItemIndicator>
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm">{releaseOf(candidate)}</span>
								<span className="block truncate text-muted-foreground text-xs">
									{songOf(candidate)}
								</span>
							</span>
							<Confidence candidate={candidate} />
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
			</MenuPopup>
		</MenuRoot>
	);
}
