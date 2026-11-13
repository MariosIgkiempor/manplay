import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Disc3, Download, FileAudio, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
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

const PILL =
	"inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[11px]";

/** Short status pill shown beside the size. */
function Status({ file, verdict }: { file: RemoteFile; verdict: Verified | undefined }) {
	if (verdict?.duplicateOf) {
		return (
			<span className={`${PILL} bg-amber-500/15 text-amber-500`}>
				<Copy className="size-3" /> Duplicate
			</span>
		);
	}
	if (verdict && !verdict.checked) {
		return <span className={`${PILL} bg-muted text-muted-foreground`}>Unchecked</span>;
	}
	if (verdict) {
		return (
			<span className={`${PILL} bg-emerald-500/15 text-emerald-500`}>
				<Check className="size-3" /> New audio
			</span>
		);
	}
	if (file.otherFormat) {
		return (
			<span className={`${PILL} bg-sky-500/15 text-sky-400`}>
				<FileAudio className="size-3" /> Have .{file.otherFormat}
			</span>
		);
	}
	return null;
}

/** Checkbox that can show a partly-selected state. */
function Checkbox({
	checked,
	partial = false,
	onChange,
	disabled,
	label,
}: {
	checked: boolean;
	partial?: boolean;
	onChange: () => void;
	disabled?: boolean;
	label: string;
}) {
	return (
		<input
			type="checkbox"
			aria-label={label}
			className="size-4 shrink-0 accent-primary"
			checked={checked}
			ref={(el) => {
				if (el) {
					el.indeterminate = partial && !checked;
				}
			}}
			onChange={onChange}
			disabled={disabled}
		/>
	);
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
	const name = file.rel.at(-1) ?? "";
	const album = file.rel.slice(1, -1).join(" / ");
	return (
		<label className="flex cursor-pointer items-start gap-3 rounded-lg py-2 pr-2 pl-9 hover:bg-muted/40">
			<input
				type="checkbox"
				className="mt-0.5 size-4 shrink-0 accent-primary"
				checked={picked}
				onChange={onToggle}
				disabled={disabled}
			/>
			<span className="min-w-0 flex-1 space-y-1">
				<span className="block break-words text-sm leading-snug">{name}</span>
				{album && (
					<span className="flex items-start gap-1.5 text-muted-foreground text-xs">
						<Disc3 className="mt-px size-3 shrink-0" />
						<span className="min-w-0 break-words">{album}</span>
					</span>
				)}
				{verdict?.duplicateOf && (
					<span className="block break-words text-amber-500/90 text-xs">
						Same audio as {verdict.duplicateOf}
					</span>
				)}
			</span>
			<span className="flex shrink-0 flex-col items-end gap-1">
				<span className="text-muted-foreground text-xs tabular-nums">{formatBytes(file.size)}</span>
				<Status file={file} verdict={verdict} />
			</span>
		</label>
	);
}

function Group({
	name,
	files,
	skipped,
	verdicts,
	disabled,
	onToggle,
	onToggleGroup,
}: {
	name: string;
	files: RemoteFile[];
	skipped: Set<string>;
	verdicts: Map<string, Verified>;
	disabled: boolean;
	onToggle: (f: RemoteFile) => void;
	onToggleGroup: (files: RemoteFile[], on: boolean) => void;
}) {
	const picked = files.filter((f) => !skipped.has(key(f))).length;
	return (
		<section>
			<div className="sticky -top-4 z-10 flex items-center gap-3 border-b bg-background px-2 pt-5 pb-2">
				<Checkbox
					checked={picked === files.length}
					partial={picked > 0}
					onChange={() => onToggleGroup(files, picked !== files.length)}
					disabled={disabled}
					label={`Select ${name}`}
				/>
				<h3 className="min-w-0 flex-1 break-words font-semibold text-base tracking-tight">
					{name}
				</h3>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{picked}/{files.length}
				</span>
			</div>
			<div>
				{files.map((f) => (
					<FileRow
						key={key(f)}
						file={f}
						picked={!skipped.has(key(f))}
						verdict={verdicts.get(key(f))}
						disabled={disabled}
						onToggle={() => onToggle(f)}
					/>
				))}
			</div>
		</section>
	);
}

/** Top-level folder (usually the artist) → its files, in listing order. */
function groupByFolder(files: RemoteFile[]): [string, RemoteFile[]][] {
	const groups = new Map<string, RemoteFile[]>();
	for (const f of files) {
		const name = f.rel.length > 1 ? (f.rel[0] ?? "") : "Loose files";
		groups.set(name, [...(groups.get(name) ?? []), f]);
	}
	return [...groups].sort(([x], [y]) => x.localeCompare(y, undefined, { sensitivity: "base" }));
}

function PullResult({ outcome: r, onDone }: { outcome: PullOutcome; onDone: () => void }) {
	return (
		<div className="space-y-3">
			<p className="text-sm">
				Pulled {r.pulled.toLocaleString()} {r.pulled === 1 ? "file" : "files"} into your library.
				{r.skipped > 0 && ` ${r.skipped} already existed.`}
			</p>
			{r.failedTotal > 0 && (
				<div className="space-y-1 text-destructive text-xs">
					<p>{r.failedTotal} failed:</p>
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
	return (
		<div className="space-y-5">
			<div className="space-y-1">
				<h2 className="font-semibold text-xl tracking-tight">
					{missing.length.toLocaleString()} {missing.length === 1 ? "track" : "tracks"} to pull
				</h2>
				<p className="text-muted-foreground text-sm">
					This folder already has audio your library is missing. Choose what to bring in before the
					first sync.
				</p>
			</div>

			<div className="space-y-4">
				{groupByFolder(missing).map(([name, files]) => (
					<Group
						key={name}
						name={name}
						files={files}
						skipped={skipped}
						verdicts={verdicts}
						disabled={busy}
						onToggle={toggle}
						onToggleGroup={toggleGroup}
					/>
				))}
			</div>

			<div className="sticky -bottom-4 z-20 -mx-4 -mb-4 space-y-2 border-t bg-background px-4 pt-3 pb-4">
				{verify.isError && <p className="text-destructive text-sm">{String(verify.error)}</p>}
				{pull.isError && <p className="text-destructive text-sm">{String(pull.error)}</p>}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="text-sm">
						<span className="font-medium">{chosen.length.toLocaleString()} selected</span>
						<span className="text-muted-foreground"> · {formatBytes(totalSize(chosen))}</span>
					</div>
					<div className="flex items-center gap-2">
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
							<ShieldCheck /> {verify.isPending ? "Verifying…" : "Check for duplicates"}
						</Button>
					</div>
				</div>
				{busy && progress && progress.total > 0 && (
					<div className="space-y-1">
						<div className="h-1 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full bg-primary transition-all"
								style={{ width: `${(progress.done / progress.total) * 100}%` }}
							/>
						</div>
						<p className="break-words text-muted-foreground text-xs">
							{progress.done}/{progress.total} · {progress.current}
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
						<Download /> {pull.isPending ? "Pulling…" : `Pull ${chosen.length.toLocaleString()}`}
					</Button>
				</div>
			</div>
		</div>
	);
}

const totalSize = (files: RemoteFile[]) => files.reduce((n, f) => n + f.size, 0);
