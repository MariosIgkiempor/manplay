import { useQueryClient } from "@tanstack/react-query";
import { Tags, Undo2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { FilePane } from "#/components/file-pane.tsx";
import { type FixNotice, HealthBar } from "#/components/library-health.tsx";
import { TagCopyDialog } from "#/components/tag-copy-dialog.tsx";
import { TagEditor, type TagTarget } from "#/components/tag-editor.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { useUndo } from "#/context/undo-context.ts";
import { confirmFix, type FixReport } from "#/lib/api.ts";
import { describeFixes, fixablePaths, indexIssues } from "#/lib/audit.ts";
import {
	useAudit,
	useAuditFix,
	useLibraryRoot,
	useTagClipboard,
	useTagsWrite,
} from "#/lib/queries.ts";
import { forTarget, type TagClipboard } from "#/lib/tag-clipboard.ts";
import type { FsClipboard } from "#/lib/use-fs-ops.ts";
import { type TagConfirmRequest, useTagConfirm } from "#/lib/use-tag-confirm.tsx";

const AUTO_KEY = "manplay.tags.autoOpen";

function loadAutoOpen(): boolean {
	try {
		return localStorage.getItem(AUTO_KEY) !== "0";
	} catch {
		return true;
	}
}

function saveAutoOpen(on: boolean) {
	try {
		localStorage.setItem(AUTO_KEY, on ? "1" : "0");
	} catch {
		// Remembering the choice is a convenience only.
	}
}

/** Asks, then applies the copied tags to each target; song-only tags are skipped on folders. */
async function pasteTagsOnto(
	clip: TagClipboard | null,
	targets: TagTarget[],
	write: (v: { path: string; edits: Record<string, string> }) => Promise<FixReport>,
	setNotice: (n: FixNotice | null) => void,
	confirm: (req: TagConfirmRequest) => Promise<boolean>,
) {
	if (!clip || targets.length === 0) {
		return;
	}
	const items = targets
		.map((t) => ({ path: t.path, name: t.name, edits: forTarget(clip.values, t.isDir) }))
		.filter((i) => Object.keys(i.edits).length > 0);
	const only = targets.length === 1 ? `"${targets[0]?.name}"` : `${targets.length} items`;
	const ok = await confirm({
		title: `Paste tags onto ${only}`,
		subtitle: `From "${clip.from}"${targets.some((t) => t.isDir) ? " · song-only tags are skipped on folders" : ""}`,
		items,
	});
	if (!ok) {
		return;
	}
	setNotice(null);
	const total: FixReport = { fixed: 0, failed: [] };
	for (const t of items) {
		try {
			const r = await write({ path: t.path, edits: t.edits });
			total.fixed += r.fixed;
			total.failed.push(...r.failed);
		} catch (e) {
			setNotice({ kind: "error", message: String(e) });
			return;
		}
	}
	setNotice({ kind: "report", report: total, verb: "Updated tags on" });
}

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
	const [tagTarget, setTagTarget] = useState<TagTarget | null>(null);
	const [tagsOpen, setTagsOpen] = useState(false);
	const { clip: tagClip, setClip: setTagClip } = useTagClipboard();
	const tagConfirm = useTagConfirm();
	const [copying, setCopying] = useState<TagTarget | null>(null);
	const tagWriter = useTagsWrite();
	const [autoOpen, setAutoOpen] = useState(loadAutoOpen);
	const fsUndo = useUndo();
	const selectTarget = useCallback(
		(t: TagTarget) => {
			setTagTarget(t);
			if (autoOpen) {
				setTagsOpen(true);
			}
		},
		[autoOpen],
	);
	const editTags = useCallback((t: TagTarget) => {
		setTagTarget(t);
		setTagsOpen(true);
	}, []);
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

	const pasteTags = (targets: TagTarget[]) =>
		pasteTagsOnto(tagClip, targets, tagWriter.mutateAsync, setNotice, tagConfirm.ask);

	return (
		<div className="relative flex h-full min-h-0 flex-col overflow-hidden border-t">
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
			<div className="flex items-center justify-end gap-3 border-b px-3 py-1 text-xs">
				<span className="flex items-center gap-2 text-muted-foreground">
					Open tags when selecting
					<Switch
						checked={autoOpen}
						onChange={(on) => {
							setAutoOpen(on);
							saveAutoOpen(on);
						}}
						label="Open the tag pane automatically when selecting a song or folder"
					/>
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void fsUndo.undo()}
					disabled={!fsUndo.canUndo}
					title={fsUndo.label ? `Undo ${fsUndo.label} (⌘Z)` : "Nothing to undo"}
				>
					<Undo2 />
					Undo
				</Button>
				<Button
					variant={tagsOpen ? "secondary" : "outline"}
					size="sm"
					onClick={() => setTagsOpen(!tagsOpen)}
					disabled={tagTarget === null}
				>
					<Tags />
					Tags
				</Button>
			</div>
			<div className="flex min-h-0 flex-1">
				{panes.map((i) => (
					<FilePane
						key={i}
						root={base}
						onRecord={fsUndo.record}
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
						onEditTags={editTags}
						onSelectTarget={selectTarget}
						tagClipboard={tagClip}
						onCopyTags={setCopying}
						onPasteTags={pasteTags}
					/>
				))}
				{tagsOpen && tagTarget && (
					<aside className="flex w-[26rem] shrink-0 flex-col border-l" aria-label="Tags">
						<TagEditor
							key={tagTarget.path}
							target={tagTarget}
							onClose={() => setTagsOpen(false)}
							confirm={tagConfirm.ask}
						/>
					</aside>
				)}
			</div>
			{copying && (
				<TagCopyDialog target={copying} onCopy={setTagClip} onClose={() => setCopying(null)} />
			)}
			{tagConfirm.dialog}
		</div>
	);
}
