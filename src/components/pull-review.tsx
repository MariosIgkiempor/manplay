import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
	DiffHunk,
	DiffLine,
	DiffNote,
	DiffRow,
	groupByDir,
	ProgressBar,
	Tally,
	type Tone,
} from "#/components/diff-view.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	onPullProgress,
	type PullOutcome,
	type PullProgress,
	type RemoteFile,
	remotePull,
	remoteScan,
	remoteVerify,
	type Verified,
} from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";

const key = (f: RemoteFile) => f.rel.join("/");
const dirOf = (f: RemoteFile) => f.rel.slice(0, -1).join("/") || "(top level)";
const nameOf = (f: RemoteFile) => f.rel.at(-1) ?? "";
const HUNKS_PER_PAGE = 40;

function Notice({ text, onDone }: { text: string; onDone: () => void }) {
	return (
		<div className="space-y-3">
			<p className="text-sm">{text}</p>
			<Button className="w-full" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

/** How one destination file looks in the diff, and why. */
function describe(
	file: RemoteFile,
	verdict: Verified | undefined,
): { tone: Tone; note: string | null } {
	if (verdict?.duplicateOf) {
		return { tone: "change", note: `Same audio as ${verdict.duplicateOf}` };
	}
	if (verdict && !verdict.checked) {
		return { tone: "add", note: "Audio could not be compared" };
	}
	if (!verdict && file.otherFormat) {
		return { tone: "move", note: `Your library has this as .${file.otherFormat}` };
	}
	return { tone: "add", note: null };
}

function FileRow({
	file,
	picked,
	verdict,
	disabled,
	onToggle,
}: {
	file: RemoteFile;
	picked: boolean;
	verdict: Verified | undefined;
	disabled: boolean;
	onToggle: () => void;
}) {
	const { tone, note } = describe(file, verdict);
	return (
		<DiffRow
			picked={picked}
			onToggle={onToggle}
			disabled={disabled}
			label={key(file)}
			aside={formatBytes(file.size)}
		>
			<DiffLine tone={tone}>{nameOf(file)}</DiffLine>
			{note && <DiffNote>{note}</DiffNote>}
		</DiffRow>
	);
}

function PullResult({ outcome: r, onDone }: { outcome: PullOutcome; onDone: () => void }) {
	return (
		<div className="space-y-5">
			<div className="flex items-center gap-2">
				<CheckCircle2 className={`size-5 ${r.failedTotal > 0 ? "text-warning" : "text-success"}`} />
				<h3 className="font-semibold text-xl tracking-tight">
					{r.failedTotal > 0 ? `Pulled with ${r.failedTotal} errors` : "Pull complete"}
				</h3>
			</div>
			<Tally
				items={[
					{ tone: "add", label: "pulled", count: r.pulled },
					{ tone: "change", label: "already existed", count: r.skipped },
				]}
				empty="Nothing was pulled"
			/>
			{r.failedTotal > 0 && (
				<div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs">
					<p className="font-medium">{r.failedTotal} failed:</p>
					{r.failed.map((m) => (
						<p key={m} className="break-all">
							{m}
						</p>
					))}
				</div>
			)}
			<Button className="w-full" onClick={onDone}>
				Done
			</Button>
		</div>
	);
}

/**
 * Shown right after a destination is added: lists audio files that already sit on the
 * destination but are missing from the library, and lets the user pull them in before the first sync.
 */
export function PullReview({ targetId, onDone }: { targetId: number; onDone: () => void }) {
	const scan = useQuery({
		queryKey: ["remote-scan", targetId],
		queryFn: () => remoteScan(targetId),
		gcTime: 0,
		retry: false,
	});
	if (scan.isPending) {
		return <p className="py-6 text-center text-muted-foreground text-sm">Checking the folder…</p>;
	}
	if (scan.isError) {
		return (
			<div className="space-y-3">
				<p className="text-destructive text-sm">{String(scan.error)}</p>
				<Button variant="outline" className="w-full" onClick={onDone}>
					Skip
				</Button>
			</div>
		);
	}
	if (scan.data.missing.length === 0) {
		return (
			<Notice
				text={
					scan.data.total === 0
						? "The folder is empty. The first sync will fill it."
						: "Your library already has every audio file in this folder."
				}
				onDone={onDone}
			/>
		);
	}
	return <Picker targetId={targetId} missing={scan.data.missing} onDone={onDone} />;
}

const filterFiles = (files: RemoteFile[], needle: string) =>
	needle === "" ? files : files.filter((f) => key(f).toLowerCase().includes(needle));

function FilterBar({
	query,
	onQuery,
	shown,
	active,
	disabled,
	onOnly,
}: {
	query: string;
	onQuery: (q: string) => void;
	shown: number;
	active: boolean;
	disabled: boolean;
	onOnly: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<input
				type="search"
				value={query}
				onChange={(e) => onQuery(e.target.value)}
				placeholder="Filter by artist, album or file name"
				aria-label="Filter files"
				className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
			/>
			{active && (
				<Button
					variant="outline"
					size="sm"
					disabled={disabled || shown === 0}
					onClick={onOnly}
					title="Tick only the files shown, untick everything else"
				>
					Pull only these ({shown.toLocaleString()})
				</Button>
			)}
		</div>
	);
}

function Picker({
	targetId,
	missing,
	onDone,
}: {
	targetId: number;
	missing: RemoteFile[];
	onDone: () => void;
}) {
	const queryClient = useQueryClient();
	const [skipped, setSkipped] = useState<Set<string>>(
		() => new Set(missing.filter((f) => f.otherFormat).map(key)),
	);
	const [verdicts, setVerdicts] = useState<Map<string, Verified>>(new Map());
	const verify = useMutation({
		mutationFn: (files: string[][]) => remoteVerify(targetId, files),
		onSuccess: (results) => {
			setVerdicts(
				(prev) => new Map([...prev, ...results.map((r) => [r.rel.join("/"), r] as const)]),
			);
			// Identical audio is already in the library: untick it.
			setSkipped(
				(prev) =>
					new Set([...prev, ...results.filter((r) => r.duplicateOf).map((r) => r.rel.join("/"))]),
			);
		},
	});
	const [progress, setProgress] = useState<PullProgress | null>(null);
	const pull = useMutation({
		mutationFn: (files: string[][]) => remotePull(targetId, files),
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-root"] });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			await queryClient.invalidateQueries({ queryKey: ["playlists"] });
		},
	});

	useEffect(() => {
		const unlisten = onPullProgress(setProgress);
		return () => {
			void unlisten.then((f) => f());
		};
	}, []);

	const [shown, setShown] = useState(HUNKS_PER_PAGE);
	const [query, setQuery] = useState("");

	if (pull.isSuccess) {
		return <PullResult outcome={pull.data} onDone={onDone} />;
	}
	const chosen = missing.filter((f) => !skipped.has(key(f)));
	const all = chosen.length === missing.length;
	const busy = pull.isPending || verify.isPending;
	const toggle = (f: RemoteFile) =>
		setSkipped((prev) => {
			const next = new Set(prev);
			if (!next.delete(key(f))) {
				next.add(key(f));
			}
			return next;
		});
	const toggleGroup = (files: RemoteFile[], on: boolean) =>
		setSkipped((prev) => {
			const next = new Set(prev);
			for (const f of files) {
				if (on) {
					next.delete(key(f));
				} else {
					next.add(key(f));
				}
			}
			return next;
		});
	const needle = query.trim().toLowerCase();
	const matching = filterFiles(missing, needle);
	const hunks = groupByDir(matching, dirOf, nameOf);
	const duplicates = missing.filter((f) => verdicts.get(key(f))?.duplicateOf).length;
	const otherFormat = missing.filter((f) => !verdicts.has(key(f)) && f.otherFormat).length;
	return (
		<div className="space-y-5">
			<div className="space-y-2">
				<h2 className="font-semibold text-xl tracking-tight">
					{missing.length.toLocaleString()} {missing.length === 1 ? "track" : "tracks"} not in your
					library
				</h2>
				<p className="text-muted-foreground text-sm">
					This folder has audio your library is missing. Tick what to copy into your library.
					Anything you leave behind stays on the destination and is never deleted by a pull.
				</p>
				<Tally
					items={[
						{ tone: "add", label: "new", count: missing.length - duplicates - otherFormat },
						{ tone: "change", label: "duplicate", count: duplicates },
						{ tone: "move", label: "other format", count: otherFormat },
					]}
				/>
			</div>

			<FilterBar
				query={query}
				onQuery={setQuery}
				shown={matching.length}
				active={needle !== ""}
				disabled={busy}
				onOnly={() => setSkipped(new Set(missing.filter((f) => !matching.includes(f)).map(key)))}
			/>

			<div className="space-y-2">
				{hunks.slice(0, shown).map(([dir, files]) => (
					<DiffHunk
						key={dir}
						dir={dir}
						total={files.length}
						picked={files.filter((f) => !skipped.has(key(f))).length}
						onToggleAll={(on) => toggleGroup(files, on)}
						disabled={busy}
						tallies={[{ tone: "add", count: files.length }]}
					>
						{files.map((f) => (
							<FileRow
								key={key(f)}
								file={f}
								picked={!skipped.has(key(f))}
								verdict={verdicts.get(key(f))}
								disabled={busy}
								onToggle={() => toggle(f)}
							/>
						))}
					</DiffHunk>
				))}
				{hunks.length > shown && (
					<Button variant="ghost" size="sm" onClick={() => setShown(shown + HUNKS_PER_PAGE)}>
						Show more folders ({hunks.length - shown} hidden)
					</Button>
				)}
			</div>

			<div className="sticky -bottom-4 z-20 -mx-4 -mb-4 space-y-3 border-t bg-background px-4 pt-3 pb-4">
				{verify.isError && <p className="text-destructive text-sm">{String(verify.error)}</p>}
				{pull.isError && <p className="text-destructive text-sm">{String(pull.error)}</p>}
				<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<Tally
						items={[{ tone: "add", label: "to pull", count: chosen.length }]}
						empty="Nothing selected"
					/>
					<span className="text-muted-foreground text-xs">{formatBytes(totalSize(chosen))}</span>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => setSkipped(all ? new Set(missing.map(key)) : new Set())}
					>
						{all ? "Select none" : "Select all"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={busy || chosen.length === 0}
						onClick={() => verify.mutate(chosen.map((f) => f.rel))}
						title="Compares audio content with your library. Reads a few KB per file."
					>
						<ShieldCheck /> {verify.isPending ? "Checking…" : "Check for duplicates"}
					</Button>
				</div>
				{busy && progress && progress.total > 0 && (
					<div className="space-y-1">
						<ProgressBar done={progress.done} total={progress.total} />
						<p className="break-all text-muted-foreground text-xs">
							{progress.done}/{progress.total}: {progress.current}
						</p>
					</div>
				)}
				<div className="flex gap-2">
					<Button variant="outline" className="flex-1" onClick={onDone} disabled={pull.isPending}>
						Skip
					</Button>
					<Button
						className="flex-1"
						disabled={busy || chosen.length === 0}
						onClick={() => pull.mutate(chosen.map((f) => f.rel))}
					>
						<Download />{" "}
						{pull.isPending ? "Pulling…" : `Pull ${chosen.length.toLocaleString()} into library`}
					</Button>
				</div>
			</div>
		</div>
	);
}

const totalSize = (files: RemoteFile[]) => files.reduce((n, f) => n + f.size, 0);
