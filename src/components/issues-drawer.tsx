import { RefreshCw, TriangleAlert, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import type { FixNotice } from "#/components/library-health.tsx";
import { Button } from "#/components/ui/button.tsx";
import { type AuditIssue, confirmFix } from "#/lib/api.ts";
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
	return (
		<button
			type="button"
			onClick={onClick}
			title="Review and fix file issues"
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<TriangleAlert className="size-3.5" />
			{plural(issues.length, "file issue", "file issues")} in {plural(files, "file", "files")}
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
	return (
		<li>
			<label
				className={cn(
					"flex gap-3 px-3 py-2",
					file.fixable ? "cursor-pointer hover:bg-muted/50" : "opacity-80",
				)}
			>
				<input
					type="checkbox"
					className="mt-0.5 size-4 shrink-0 accent-primary"
					checked={checked}
					disabled={!file.fixable || disabled}
					onChange={onToggle}
					aria-label={`Select ${file.path}`}
				/>
				<span className="min-w-0 flex-1 space-y-0.5">
					<span className="block truncate font-medium text-sm" title={file.path}>
						{file.path.split(/[\\/]/).pop()}
					</span>
					<span className="block truncate text-muted-foreground text-xs" title={file.path}>
						{rel}
					</span>
					{file.issues.map((i) => (
						<span
							key={i.kind + i.message}
							className={cn("block text-xs", i.fixable ? "text-warning" : "text-muted-foreground")}
						>
							{i.message}
							{!i.fixable && " (fix it by hand in Files)"}
						</span>
					))}
				</span>
			</label>
		</li>
	);
}

function FileList({
	files,
	root,
	picked,
	disabled,
	loading,
	onToggle,
}: {
	files: FileIssues[];
	root: string;
	picked: ReadonlySet<string>;
	disabled: boolean;
	loading: boolean;
	onToggle: (path: string) => void;
}) {
	if (files.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				{loading ? "Checking library…" : "No issues. The library follows its conventions."}
			</p>
		);
	}
	return (
		<ul className="divide-y rounded-lg border">
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
		</ul>
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

function Toolbar({
	picked,
	fixableCount,
	allPicked,
	fixing,
	checking,
	onPickAll,
	onFixPicked,
	onFixAll,
	onRecheck,
}: {
	picked: number;
	fixableCount: number;
	allPicked: boolean;
	fixing: boolean;
	checking: boolean;
	onPickAll: () => void;
	onFixPicked: () => void;
	onFixAll: () => void;
	onRecheck: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					className="size-4 accent-primary"
					checked={allPicked}
					disabled={fixableCount === 0 || fixing}
					onChange={onPickAll}
				/>
				{picked > 0 ? `${picked} selected` : "Select all"}
			</label>
			<div className="ml-auto flex items-center gap-2">
				<Button size="sm" disabled={picked === 0 || fixing} onClick={onFixPicked}>
					<Wrench />
					{fixing ? "Fixing…" : `Fix selected (${picked})`}
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={fixableCount === 0 || fixing}
					onClick={onFixAll}
				>
					Fix all ({fixableCount})
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Check again"
					title="Check again"
					disabled={checking || fixing}
					onClick={onRecheck}
				>
					<RefreshCw className={checking ? "animate-spin" : undefined} />
				</Button>
			</div>
		</div>
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

	const fix = async (paths: string[]) => {
		if (paths.length === 0 || !(await confirmFix(describeFixes(audit.data ?? [], paths)))) {
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
		return <p className="text-destructive text-sm">{String(audit.error)}</p>;
	}
	return (
		<div className="space-y-4">
			<Toolbar
				picked={picked.size}
				fixableCount={fixable.length}
				allPicked={allPicked}
				fixing={fixer.isPending}
				checking={audit.isFetching}
				onPickAll={() => setPicked(allPicked ? new Set() : new Set(fixable.map((f) => f.path)))}
				onFixPicked={() => void fix([...picked])}
				onFixAll={() => void fix(fixable.map((f) => f.path))}
				onRecheck={() => void audit.refetch()}
			/>
			{noFfmpeg && (
				<p className="text-muted-foreground text-xs">
					Install ffmpeg (<code>brew install ffmpeg</code>) to convert non-MP3 files.
				</p>
			)}
			{notice && <ResultLine notice={notice} />}
			<FileList
				files={files}
				root={root}
				picked={picked}
				disabled={fixer.isPending}
				loading={audit.isPending}
				onToggle={toggle}
			/>
		</div>
	);
}

function ResultLine({ notice }: { notice: FixNotice }) {
	if (notice.kind === "error") {
		return <p className="text-destructive text-sm">{notice.message}</p>;
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
				<p key={f.path} className="truncate text-xs" title={f.error}>
					{f.path.split(/[\\/]/).pop()}: {f.error}
				</p>
			))}
			{failed.length > 3 && <p className="text-xs">and {failed.length - 3} more</p>}
		</div>
	);
}

/** Slide-over listing every file issue, with checkboxes to choose what to fix. */
export function IssuesDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
	return (
		<Drawer open={open} onClose={onClose} title="File issues" width="w-[36rem]">
			<IssuesBody />
		</Drawer>
	);
}
