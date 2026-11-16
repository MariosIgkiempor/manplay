import { Tags, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePane } from "#/components/file-pane.tsx";
import { FileShortcuts } from "#/components/file-shortcuts.tsx";
import { type FixNotice, HealthBar } from "#/components/library-health.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { TagCopyDialog } from "#/components/tag-copy-dialog.tsx";
import type { TagTarget } from "#/components/tag-editor.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useUndo } from "#/context/undo-context.ts";
import { confirmFix, type FixReport } from "#/lib/api.ts";
import { describeFixes, fixablePaths, indexIssues } from "#/lib/audit.ts";
import {
	useAudit,
	useAuditFix,
	useLibraryRoot,
	useTagClipboard,
	useTagsWrite,
	useTracks,
} from "#/lib/queries.ts";
import { forTarget, type TagClipboard } from "#/lib/tag-clipboard.ts";
import { DEFAULT_FILE_SORT, type FileSort } from "#/lib/tree.ts";
import type { FsClipboard } from "#/lib/use-fs-ops.ts";
import { type TagConfirmRequest, useTagConfirm } from "#/lib/use-tag-confirm.tsx";
import { useTagPanelNav } from "#/lib/use-tag-panel-nav.ts";

const AUTO_KEY = "manplay.tags.autoOpen";
const VIEW_KEY = "manplay.files.view";

/** Where each pane was, whether the view was split, and the sort, so coming back resumes there. */
interface SavedView {
	paths: [string | null, string | null];
	split: boolean;
	sort: FileSort;
}

const SORT_KEYS = new Set(["name", "size", "modified"]);

function loadView(): SavedView {
	const fallback: SavedView = { paths: [null, null], split: false, sort: DEFAULT_FILE_SORT };
	try {
		const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
		if (!v || typeof v !== "object") {
			return fallback;
		}
		const str = (x: unknown) => (typeof x === "string" ? x : null);
		return {
			paths: [str(v.paths?.[0]), str(v.paths?.[1])],
			split: v.split === true,
			sort: SORT_KEYS.has(v.sort?.key)
				? { key: v.sort.key, desc: v.sort.desc === true }
				: DEFAULT_FILE_SORT,
		};
	} catch {
		return fallback;
	}
}

function saveView(v: SavedView) {
	try {
		localStorage.setItem(VIEW_KEY, JSON.stringify(v));
	} catch {
		// Resuming where you were is a convenience only.
	}
}

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

/** Asks, then applies the copied tags to each target; song-only fields are skipped on folders. */
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
		title: `Paste metadata onto ${only}`,
		subtitle: `From "${clip.from}"${targets.some((t) => t.isDir) ? " · song-only fields are skipped on folders" : ""}`,
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
	setNotice({ kind: "report", report: total, verb: "Updated metadata on" });
}

/** Two-pane file manager over the library folder. */
export function FilesView() {
	const root = useLibraryRoot();
	const audit = useAudit();
	const tracks = useTracks();
	const fixer = useAuditFix();
	const [saved] = useState(loadView);
	const [split, setSplit] = useState(saved.split);
	const [sort, setSort] = useState<FileSort>(saved.sort);
	const [shortcuts, setShortcuts] = useState(false);
	const [clipboard, setClipboard] = useState<FsClipboard | null>(null);
	const [active, setActive] = useState<0 | 1>(0);
	const [notice, setNotice] = useState<FixNotice | null>(null);
	const [tagTarget, setTagTarget] = useState<TagTarget | null>(null);
	const detail = useDetail();
	const detailRef = useRef(detail);
	detailRef.current = detail;
	// The editor lives in the app's side panel, shared with songs, albums and artists.
	const tagsOpen = detail.view?.kind === "edit";
	const { clip: tagClip, setClip: setTagClip } = useTagClipboard();
	const tagConfirm = useTagConfirm();
	const [copying, setCopying] = useState<TagTarget | null>(null);
	const tagWriter = useTagsWrite();
	const [autoOpen, setAutoOpen] = useState(loadAutoOpen);
	const fsUndo = useUndo();
	const selectTarget = useCallback(
		(t: TagTarget) => {
			setTagTarget(t);
			const { view, open } = detailRef.current;
			if (autoOpen || view?.kind === "edit") {
				open({ kind: "edit", target: t });
			}
		},
		[autoOpen],
	);
	const editTags = useCallback((t: TagTarget) => {
		setTagTarget(t);
		detailRef.current.open({ kind: "edit", target: t });
	}, []);
	const rootRef = useRef<HTMLDivElement>(null);
	const openTags = useCallback(() => {
		if (tagTarget) {
			detailRef.current.open({ kind: "edit", target: tagTarget });
		}
	}, [tagTarget]);
	const tagNav = useTagPanelNav({
		root: rootRef,
		hasTarget: tagTarget !== null,
		activePane: active,
		open: openTags,
		enabled: tagsOpen,
	});
	// Per-pane folder; `null` means "the library root".
	const [paths, setPaths] = useState<[string | null, string | null]>(saved.paths);
	useEffect(() => saveView({ paths, split, sort }), [paths, split, sort]);

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
	/** A remembered folder only counts while it is still inside the library folder. */
	const at = (i: 0 | 1) => {
		const p = paths[i];
		return p && (p === base || p.startsWith(`${base}/`)) ? p : base;
	};
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
		<div ref={rootRef} className="relative flex h-full min-h-0 flex-col overflow-hidden border-t">
			<HealthBar
				error={audit.isError ? String(audit.error) : null}
				notice={notice}
				onDismiss={() => setNotice(null)}
			/>
			<div className="flex items-center justify-end gap-3 border-b px-3 py-1 text-xs">
				<span className="flex items-center gap-2 text-muted-foreground">
					Open metadata when selecting
					<Switch
						checked={autoOpen}
						onChange={(on) => {
							setAutoOpen(on);
							saveAutoOpen(on);
						}}
						label="Open the metadata pane automatically when selecting a song or folder"
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
					onClick={() => (tagsOpen ? detail.close() : openTags())}
					disabled={tagTarget === null}
				>
					<Tags />
					Metadata
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
						onFocusTags={tagNav.focusTags}
						sort={sort}
						onSort={setSort}
						onShowShortcuts={() => setShortcuts(true)}
					/>
				))}
			</div>
			{copying && (
				<TagCopyDialog target={copying} onCopy={setTagClip} onClose={() => setCopying(null)} />
			)}
			<StatusBar>
				<Stat label="Songs" value={tracks.data?.length ?? 0} />
				<Stat label="Issues" value={issues?.length ?? 0} />
			</StatusBar>
			{tagConfirm.dialog}
			{shortcuts && <FileShortcuts onClose={() => setShortcuts(false)} />}
		</div>
	);
}
