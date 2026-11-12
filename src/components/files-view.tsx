import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { FilePane } from "#/components/file-pane.tsx";
import { type FixNotice, HealthBar } from "#/components/library-health.tsx";
import { confirmFix } from "#/lib/api.ts";
import { describeFixes, fixablePaths, indexIssues } from "#/lib/audit.ts";
import { useAudit, useAuditFix, useLibraryRoot } from "#/lib/queries.ts";
import type { FsClipboard } from "#/lib/use-fs-ops.ts";

/** Two-pane file manager over the library folder. */
export function FilesView() {
	const root = useLibraryRoot();
	const audit = useAudit();
	const fixer = useAuditFix();
	const queryClient = useQueryClient();
	const [split, setSplit] = useState(false);
	const [clipboard, setClipboard] = useState<FsClipboard | null>(null);
	const [active, setActive] = useState<0 | 1>(0);
	const [notice, setNotice] = useState<FixNotice | null>(null);
	// Per-pane folder; `null` means "the library root".
	const [paths, setPaths] = useState<[string | null, string | null]>([null, null]);

	const issues = audit.data;
	const health = useMemo(() => indexIssues(root.data ?? "", issues ?? []), [root.data, issues]);

	if (root.data === undefined || root.data === null) {
		return (
			<div className="p-6">
				<p className="text-muted-foreground text-sm">
					{root.isSuccess ? "Choose a library folder in Library first." : "Loading…"}
				</p>
			</div>
		);
	}
	const base = root.data;
	const at = (i: 0 | 1) => paths[i] ?? base;
	const go = (i: 0 | 1) => (p: string) =>
		setPaths((prev) => (i === 0 ? [p, prev[1]] : [prev[0], p]));
	const toggleSplit = () => {
		if (split) {
			setActive(0);
		} else {
			setPaths(([a]) => [a, a]);
		}
		setSplit(!split);
	};
	const panes: (0 | 1)[] = split ? [0, 1] : [0];

	/** Fixes the fixable files at or under `scopes` (the whole library when omitted). */
	const fix = async (scopes?: string[]) => {
		const targets = fixablePaths(issues ?? [], scopes);
		if (targets.length === 0 || !(await confirmFix(describeFixes(issues ?? [], targets)))) {
			return;
		}
		setNotice(null);
		fixer.mutate(targets, {
			onSuccess: (report) => setNotice({ kind: "report", report }),
			onError: (e) => setNotice({ kind: "error", message: String(e) }),
		});
	};

	return (
		<div className="flex h-full min-h-0 flex-col border-t">
			<HealthBar
				issues={issues}
				checking={audit.isFetching}
				error={audit.isError ? String(audit.error) : null}
				fixing={fixer.isPending}
				notice={notice}
				onFixAll={() => fix()}
				onRecheck={() => queryClient.invalidateQueries({ queryKey: ["audit"] })}
				onDismiss={() => setNotice(null)}
			/>
			<div className="flex min-h-0 flex-1">
				{panes.map((i) => (
					<FilePane
						key={i}
						root={base}
						path={at(i)}
						onNavigate={go(i)}
						active={split && active === i}
						onActivate={() => setActive(i)}
						clipboard={clipboard}
						setClipboard={setClipboard}
						onToggleSplit={toggleSplit}
						otherPath={split ? at(i === 0 ? 1 : 0) : null}
						health={health}
						fixing={fixer.isPending}
						onFix={fix}
					/>
				))}
			</div>
		</div>
	);
}
