import { RefreshCw, TriangleAlert, X } from "lucide-react";
import { ErrorText } from "#/components/error-text.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { AuditIssue, FixReport } from "#/lib/api.ts";

export type FixNotice = { kind: "report"; report: FixReport } | { kind: "error"; message: string };

interface BarProps {
	issues: readonly AuditIssue[] | undefined;
	checking: boolean;
	error: string | null;
	fixing: boolean;
	notice: FixNotice | null;
	onFixAll: () => void;
	onRecheck: () => void;
	onDismiss: () => void;
}

const MAX_SHOWN = 3;

function name(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/** Summary of library problems above the file panes, with the one-press fix. */
export function HealthBar({
	issues,
	checking,
	error,
	fixing,
	notice,
	onFixAll,
	onRecheck,
	onDismiss,
}: BarProps) {
	const all = issues ?? [];
	return (
		<div className="border-b text-sm">
			{error && (
				<ErrorText
					className="bg-destructive/10 px-3 py-1.5 text-destructive text-xs"
					message={error}
				/>
			)}
			{notice && <Notice notice={notice} onDismiss={onDismiss} />}
			{all.length > 0 && (
				<Summary
					issues={all}
					checking={checking}
					fixing={fixing}
					onFixAll={onFixAll}
					onRecheck={onRecheck}
				/>
			)}
			{issues === undefined && checking && (
				<p className="px-3 py-1 text-muted-foreground text-xs">Checking library…</p>
			)}
		</div>
	);
}

function Summary({
	issues,
	checking,
	fixing,
	onFixAll,
	onRecheck,
}: {
	issues: readonly AuditIssue[];
	checking: boolean;
	fixing: boolean;
	onFixAll: () => void;
	onRecheck: () => void;
}) {
	const files = new Set(issues.map((i) => i.path)).size;
	const fixable = new Set(issues.filter((i) => i.fixable).map((i) => i.path)).size;
	const manual = files - fixable;
	const noFfmpeg = issues.some((i) => i.kind === "notMp3" && !i.fixable);
	return (
		<div className="flex flex-wrap items-center gap-3 bg-amber-500/10 px-3 py-1.5">
			<TriangleAlert className="size-4 shrink-0 text-amber-500" />
			<span className="min-w-0 flex-1">
				{issues.length} {issues.length === 1 ? "issue" : "issues"} in {files}{" "}
				{files === 1 ? "file" : "files"}
				{manual > 0 && fixable > 0 && ` · ${manual} need manual attention`}
				{noFfmpeg && " · install ffmpeg (brew install ffmpeg) to convert to MP3"}
			</span>
			<Button size="sm" disabled={fixable === 0 || fixing} onClick={onFixAll}>
				{fixing ? "Fixing…" : `Fix all (${fixable})`}
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
	);
}

function Notice({ notice, onDismiss }: { notice: FixNotice; onDismiss: () => void }) {
	const failed = notice.kind === "report" ? notice.report.failed : [];
	const bad = notice.kind === "error" || failed.length > 0;
	return (
		<div
			className={`flex items-start gap-3 px-3 py-1.5 text-xs ${bad ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10"}`}
		>
			<div className="min-w-0 flex-1">
				{notice.kind === "error" ? (
					<p>{notice.message}</p>
				) : (
					<>
						<p>
							Fixed {notice.report.fixed} {notice.report.fixed === 1 ? "file" : "files"}
							{failed.length > 0 && `, ${failed.length} failed and left as they were:`}
						</p>
						{failed.slice(0, MAX_SHOWN).map((f) => (
							<p key={f.path} className="truncate">
								{name(f.path)}: {f.error}
							</p>
						))}
						{failed.length > MAX_SHOWN && <p>and {failed.length - MAX_SHOWN} more</p>}
					</>
				)}
			</div>
			<Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
				<X />
			</Button>
		</div>
	);
}
