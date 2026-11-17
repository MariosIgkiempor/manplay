import { X } from "lucide-react";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import type { FixReport } from "#/lib/api.ts";

export type FixNotice =
	| { kind: "report"; report: FixReport; verb?: string }
	| { kind: "error"; message: string };

interface BarProps {
	error: string | null;
	notice: FixNotice | null;
	onDismiss: () => void;
}

const MAX_SHOWN = 3;

function name(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/** Errors and the outcome of the last fix above the file panes; the issue list is in the status bar. */
export function HealthBar({ error, notice, onDismiss }: BarProps) {
	if (!error && !notice) {
		return null;
	}
	return (
		<div className="border-b text-sm">
			{error && <ErrorLine className="bg-destructive/10 px-3 py-1.5">{error}</ErrorLine>}
			{notice && <Notice notice={notice} onDismiss={onDismiss} />}
		</div>
	);
}

function Notice({ notice, onDismiss }: { notice: FixNotice; onDismiss: () => void }) {
	const failed = notice.kind === "report" ? notice.report.failed : [];
	const bad = notice.kind === "error" || failed.length > 0;
	return (
		<div
			className={`flex items-start gap-3 px-3 py-1.5 text-xs ${bad ? "bg-destructive/10 text-destructive" : "bg-success/10"}`}
		>
			<div className="min-w-0 flex-1">
				{notice.kind === "error" ? (
					<p>{notice.message}</p>
				) : (
					<>
						<p>
							{notice.verb ?? "Fixed"} {notice.report.fixed}{" "}
							{notice.report.fixed === 1 ? "file" : "files"}
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
