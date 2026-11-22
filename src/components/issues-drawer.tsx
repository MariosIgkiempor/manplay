import { RefreshCw, Square, SquareCheck, TriangleAlert, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { fileMenuEntries } from "#/components/file-menu.tsx";
import type { FixNotice } from "#/components/library-health.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine, LoadingLine } from "#/components/page.tsx";
import {
	PanelActions,
	PanelIntro,
	PROBLEM_ROW,
	ProblemList,
	ProblemsCleared,
	ProblemText,
} from "#/components/problem-panel.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { PanelBarTitle } from "#/context/panel-bar.tsx";
import type { AuditIssue } from "#/lib/api.ts";
import { describeFixes } from "#/lib/audit.ts";
import { useAudit, useAuditFix, useLibraryRoot } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** Issues grouped by file, in path order. */
interface FileIssues {
	path: string;
	issues: AuditIssue[];
	fixable: boolean;
}

function groupByFile(issues: readonly AuditIssue[]): FileIssues[] {
	const map = new Map<string, FileIssues>();
	for (const i of issues) {
		const entry = map.get(i.path) ?? { path: i.path, issues: [], fixable: false };
		entry.issues.push(i);
		entry.fixable ||= i.fixable;
		map.set(i.path, entry);
	}
	return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Status bar notice: files break the library conventions. Hidden when there are none. */
export function IssuesIndicator({ onClick }: { onClick: () => void }) {
	const issues = useAudit().data ?? [];
	if (issues.length === 0) {
		return null;
	}
	const files = new Set(issues.map((i) => i.path)).size;
	const full = `${plural(issues.length, "file issue", "file issues")} in ${plural(files, "file", "files")}`;
	return (
		<button
			type="button"
			onClick={onClick}
			data-hint={`${full}. Review and fix them.`}
			aria-label={full}
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<TriangleAlert className="size-3.5" />
			{plural(issues.length, "issue", "issues")}
		</button>
	);
}

function FileRow({
	file,
	root,
	checked,
	disabled,
	onToggle,
}: {
	file: FileIssues;
	root: string;
	checked: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	const rel = file.path.startsWith(root)
		? file.path.slice(root.length).replace(/^[\\/]/, "")
		: file.path;
	const name = file.path.split(/[\\/]/).pop() ?? file.path;
	return (
		<RowMenu
			label={name}
			render={<li />}
			items={[
				file.fixable && {
					label: checked ? "Leave out of the fix" : "Include in the fix",
					icon: checked ? <Square /> : <SquareCheck />,
					disabled,
					onSelect: onToggle,
				},
				"separator",
				...fileMenuEntries(file.path),
			]}
		>
			{/* The whole row ticks the file, as its checkbox does. */}
			<label className={cn(PROBLEM_ROW, file.fixable ? "cursor-pointer" : "opacity-80")}>
				<input
					type="checkbox"
					className="mt-0.5 size-4 shrink-0 accent-primary"
					checked={checked}
					disabled={!file.fixable || disabled}
					onChange={onToggle}
					aria-label={`Select ${file.path}`}
				/>
				<ProblemText
					name={name}
					where={rel.split(/[\\/]/).slice(0, -1).join(" / ") || "Library folder"}
					hint={file.path}
					notes={file.issues.map((i) => ({
						text: i.fixable ? i.message : `${i.message} (fix it by hand in Files)`,
						tone: i.fixable ? "warning" : "muted",
					}))}
				/>
			</label>
		</RowMenu>
	);
}

function FileList({
	files,
	root,
	picked,
	allPicked,
	fixableCount,
	disabled,
	loading,
	onToggle,
	onPickAll,
}: {
	files: FileIssues[];
	root: string;
	picked: ReadonlySet<string>;
	allPicked: boolean;
	fixableCount: number;
	disabled: boolean;
	loading: boolean;
	onToggle: (path: string) => void;
	onPickAll: () => void;
}) {
	if (files.length === 0) {
		return loading ? (
			<LoadingLine>Checking the library…</LoadingLine>
		) : (
			<ProblemsCleared title="No file issues">
				Every file follows the library's conventions.
			</ProblemsCleared>
		);
	}
	return (
		<ProblemList title={plural(files.length, "file", "files")}>
			<li>
				<label className={cn(PROBLEM_ROW, "items-center py-2 text-muted-foreground text-xs")}>
					<input
						type="checkbox"
						className="size-4 shrink-0 accent-primary"
						checked={allPicked}
						disabled={fixableCount === 0 || disabled}
						onChange={onPickAll}
					/>
					{picked.size > 0
						? `${picked.size} of ${fixableCount} fixable files ticked`
						: `Tick all ${fixableCount} fixable files`}
				</label>
			</li>
			{files.map((f) => (
				<FileRow
					key={f.path}
					file={f}
					root={root}
					checked={picked.has(f.path)}
					disabled={disabled}
					onToggle={() => onToggle(f.path)}
				/>
			))}
		</ProblemList>
	);
}

/** Selected file paths; picks for files that are fixed or gone after a recheck drop out. */
function usePicks(fixable: readonly FileIssues[]) {
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		setPicked((prev) => {
			const live = new Set(fixable.map((f) => f.path));
			const next = new Set([...prev].filter((p) => live.has(p)));
			return next.size === prev.size ? prev : next;
		});
	}, [fixable]);
	return [picked, setPicked] as const;
}

function FixLines({ lines }: { lines: readonly string[] }) {
	return <span className="whitespace-pre-line">{lines.join("\n")}</span>;
}

function Actions({
	picked,
	fixableCount,
	fixing,
	checking,
	onFixPicked,
	onFixAll,
	onRecheck,
	pickedConsequence,
	allConsequence,
}: {
	picked: number;
	fixableCount: number;
	fixing: boolean;
	checking: boolean;
	onFixPicked: () => void;
	onFixAll: () => void;
	onRecheck: () => void;
	pickedConsequence: ReactNode;
	allConsequence: ReactNode;
}) {
	return (
		<PanelActions>
			<ConfirmButton
				size="sm"
				disabled={picked === 0 || fixing}
				confirmLabel={`Fix ${picked} ticked`}
				consequence={pickedConsequence}
				onConfirm={onFixPicked}
			>
				<Wrench />
				{fixing ? "Fixing…" : `Fix ticked (${picked})`}
			</ConfirmButton>
			<ConfirmButton
				size="sm"
				variant="outline"
				disabled={fixableCount === 0 || fixing}
				confirmLabel={`Fix all ${fixableCount}`}
				consequence={allConsequence}
				onConfirm={onFixAll}
			>
				Fix all ({fixableCount})
			</ConfirmButton>
			<Button
				variant="ghost"
				size="sm"
				className="ml-auto"
				disabled={checking || fixing}
				onClick={onRecheck}
			>
				<RefreshCw className={checking ? "animate-spin motion-reduce:animate-none" : undefined} />
				Check again
			</Button>
		</PanelActions>
	);
}

function IssuesBody() {
	const audit = useAudit();
	const root = useLibraryRoot().data ?? "";
	const fixer = useAuditFix();
	const files = useMemo(() => groupByFile(audit.data ?? []), [audit.data]);
	const fixable = useMemo(() => files.filter((f) => f.fixable), [files]);
	const [picked, setPicked] = usePicks(fixable);
	const [notice, setNotice] = useState<FixNotice | null>(null);
	const noFfmpeg = (audit.data ?? []).some((i) => i.kind === "notMp3" && !i.fixable);

	const toggle = (path: string) =>
		setPicked((prev) => {
			const next = new Set(prev);
			if (!next.delete(path)) {
				next.add(path);
			}
			return next;
		});
	const allPicked = fixable.length > 0 && picked.size === fixable.length;

	const fix = (paths: string[]) => {
		if (paths.length === 0) {
			return;
		}
		setNotice(null);
		fixer.mutate(paths, {
			onSuccess: (report) => {
				setNotice({ kind: "report", report });
				setPicked(new Set());
			},
			onError: (e) => setNotice({ kind: "error", message: String(e) }),
		});
	};

	if (audit.isError) {
		return <ErrorLine>{String(audit.error)}</ErrorLine>;
	}
	return (
		<div className="space-y-4">
			<PanelIntro>
				These files break the library's conventions: where they sit, their file type or their tag
				version. Tick the ones to fix, or fix them all.
			</PanelIntro>
			{noFfmpeg && (
				<PanelIntro>
					ffmpeg is missing from this copy of manplay, so non-MP3 files cannot be converted.
					Reinstall the app.
				</PanelIntro>
			)}
			<Actions
				picked={picked.size}
				fixableCount={fixable.length}
				fixing={fixer.isPending}
				checking={audit.isFetching}
				onFixPicked={() => fix([...picked])}
				onFixAll={() => fix(fixable.map((f) => f.path))}
				pickedConsequence={<FixLines lines={describeFixes(audit.data ?? [], [...picked])} />}
				allConsequence={
					<FixLines
						lines={describeFixes(
							audit.data ?? [],
							fixable.map((f) => f.path),
						)}
					/>
				}
				onRecheck={() => void audit.refetch()}
			/>
			{notice && <ResultLine notice={notice} />}
			<FileList
				files={files}
				root={root}
				picked={picked}
				allPicked={allPicked}
				fixableCount={fixable.length}
				disabled={fixer.isPending}
				loading={audit.isPending}
				onToggle={toggle}
				onPickAll={() => setPicked(allPicked ? new Set() : new Set(fixable.map((f) => f.path)))}
			/>
		</div>
	);
}

function ResultLine({ notice }: { notice: FixNotice }) {
	if (notice.kind === "error") {
		return <ErrorLine>{notice.message}</ErrorLine>;
	}
	const failed = notice.report.failed;
	return (
		<div
			className={cn("space-y-0.5 text-sm", failed.length > 0 ? "text-destructive" : "text-success")}
		>
			<p>
				Fixed {plural(notice.report.fixed, "file", "files")}
				{failed.length > 0 && `, ${failed.length} failed and left as they were:`}
			</p>
			{failed.slice(0, 3).map((f) => (
				<p key={f.path} className="truncate text-xs" data-hint={f.error}>
					{f.path.split(/[\\/]/).pop()}: {f.error}
				</p>
			))}
			{failed.length > 3 && <p className="text-xs">and {failed.length - 3} more</p>}
		</div>
	);
}

/** The side panel listing every file issue, with checkboxes to choose what to fix. */
export function IssuesPanel() {
	return (
		<>
			<PanelBarTitle>File issues</PanelBarTitle>
			<IssuesBody />
		</>
	);
}
