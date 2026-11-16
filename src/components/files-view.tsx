import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePane } from "#/components/file-pane.tsx";
import { FileShortcuts } from "#/components/file-shortcuts.tsx";
import { FilesHeader } from "#/components/files-header.tsx";
import { FilesSourcePicker } from "#/components/files-source-picker.tsx";
import { type FixNotice, HealthBar } from "#/components/library-health.tsx";
import { NoticeBar } from "#/components/notice-bar.tsx";
import { RemotePane } from "#/components/remote-pane.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { TagCopyDialog } from "#/components/tag-copy-dialog.tsx";
import type { TagTarget } from "#/components/tag-editor.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useUndo } from "#/context/undo-context.ts";
import { confirmFix, type FixReport } from "#/lib/api.ts";
import { describeFixes, fixablePaths, indexIssues } from "#/lib/audit.ts";
import { isInside } from "#/lib/fs-path.ts";
import {
	useAudit,
	useAuditFix,
	useLibraryRoot,
	useSyncTargets,
	useTagClipboard,
	useTagsWrite,
	useTracks,
} from "#/lib/queries.ts";
import { forTarget, type TagClipboard } from "#/lib/tag-clipboard.ts";
import { DEFAULT_FILE_SORT, type FileSort } from "#/lib/tree.ts";
import { DragProvider } from "#/lib/use-file-drag.tsx";
import type { FsClipboard } from "#/lib/use-fs-ops.ts";
import { usePaneSources } from "#/lib/use-pane-sources.ts";
import { type TagConfirmRequest, useTagConfirm } from "#/lib/use-tag-confirm.tsx";
import { useTagPanelNav } from "#/lib/use-tag-panel-nav.ts";
import { useTransfer } from "#/lib/use-transfer.tsx";

const AUTO_KEY = "manplay.tags.autoOpen";
const VIEW_KEY = "manplay.files.view";

/** Where each pane was, whether the view was split, and the sort, so coming back resumes there. */
interface SavedView {
	paths: [string | null, string | null];
	split: boolean;
	sort: FileSort;
	/** The destination shown in the second pane; `null` for the library. */
	right: number | null;
}

const SORT_KEYS = new Set(["name", "size", "modified"]);

function loadView(): SavedView {
	const fallback: SavedView = {
		paths: [null, null],
		split: false,
		sort: DEFAULT_FILE_SORT,
		right: null,
	};
	try {
		const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
		if (!v || typeof v !== "object") {
			return fallback;
		}
		const str = (x: unknown) => (typeof x === "string" ? x : null);
		return {
			paths: [str(v.paths?.[0]), str(v.paths?.[1])],
			split: v.split === true,
			right: Number.isInteger(v.right) && v.right > 0 ? v.right : null,
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

/** Shown instead of the panes until the library folder is known. */
function NoFolderNote({ loaded }: { loaded: boolean }) {
	return (
		<div className="p-6">
			<p className="text-muted-foreground text-sm">
				{loaded ? "Choose a library folder in Library first." : "Loading…"}
			</p>
		</div>
	);
}

/**
 * Two-pane file manager. Each pane shows the library folder or a destination, and rows can be
 * dragged between panes: inside the library or one destination they move, between the library and
 * a destination they copy.
 */
export function FilesView({
	target,
	onSourceChange,
}: {
	target: number | undefined;
	/** Chooses what the first pane shows (the page's address holds it). */
	onSourceChange: (id: number | undefined) => void;
}) {
	const root = useLibraryRoot();
	const audit = useAudit();
	const tracks = useTracks();
	const fixer = useAuditFix();
	const [saved] = useState(loadView);
	const [split, setSplit] = useState(saved.split);
	const [sort, setSort] = useState<FileSort>(saved.sort);
	const [right, setRight] = useState<number | null>(saved.right);
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
	useEffect(() => saveView({ paths, split, sort, right }), [paths, split, sort, right]);

	const issues = audit.data;
	const health = useMemo(() => indexIssues(root.data ?? "", issues ?? []), [root.data, issues]);

	const destinations = useSyncTargets();
	const { sources, nameOf: nameOfSource } = usePaneSources(target, right);
	const transfer = useTransfer(nameOfSource);

	const panesShown: (0 | 1)[] = split ? [0, 1] : [0];
	const hasLocal = panesShown.some((i) => sources[i].kind === "library");

	const toggleSplit = () => {
		if (split) {
			setActive(0);
		} else {
			setPaths(([a]) => [a, a]);
		}
		setSplit(!split);
	};
	const header = (
		<FilesHeader
			target={
				sources[0].kind === "remote"
					? destinations.data?.find((t) => t.id === (sources[0] as { id: number }).id)
					: undefined
			}
			onSourceChange={onSourceChange}
			split={split}
			onToggleSplit={toggleSplit}
			hasLocal={hasLocal}
			canUndo={fsUndo.canUndo}
			undoLabel={fsUndo.label}
			onUndo={() => void fsUndo.undo()}
			tagsOpen={tagsOpen}
			canOpenTags={tagTarget !== null}
			onToggleTags={() => (tagsOpen ? detail.close() : openTags())}
			autoOpen={autoOpen}
			onAutoOpen={(on) => {
				setAutoOpen(on);
				saveAutoOpen(on);
			}}
		/>
	);

	if (hasLocal && (root.data === undefined || root.data === null)) {
		return (
			<main className="flex h-full flex-col">
				{header}
				<NoFolderNote loaded={root.isSuccess} />
			</main>
		);
	}
	const base = root.data ?? "";
	/** A remembered folder only counts while it is still inside the library folder. */
	const at = (i: 0 | 1) => {
		const p = paths[i];
		return p && (p === base || isInside(p, base)) ? p : base;
	};
	const go = (i: 0 | 1) => (p: string) =>
		setPaths((prev) => (i === 0 ? [p, prev[1]] : [prev[0], p]));
	const panes = panesShown;

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

	/** Split panes each choose their own source; a single pane uses the header's. */
	const pickerFor = (i: 0 | 1) =>
		split ? (
			<FilesSourcePicker
				variant="field"
				value={sources[i].kind === "remote" ? (sources[i] as { id: number }).id : undefined}
				onChange={(id) => (i === 0 ? onSourceChange(id) : setRight(id ?? null))}
			/>
		) : undefined;

	const libraryPane = (i: 0 | 1) => (
		<FilePane
			key="library"
			pane={i}
			root={base}
			onRecord={fsUndo.record}
			path={at(i)}
			onNavigate={go(i)}
			active={split && active === i}
			onActivate={() => setActive(i)}
			clipboard={clipboard}
			setClipboard={setClipboard}
			sourcePicker={pickerFor(i)}
			otherPath={split && sources[i === 0 ? 1 : 0].kind === "library" ? at(i === 0 ? 1 : 0) : null}
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
	);

	const pane = (i: 0 | 1) => {
		const src = sources[i];
		return src.kind === "remote" ? (
			<RemotePane
				key={`remote-${src.id}`}
				pane={i}
				targetId={src.id}
				label={nameOfSource(src)}
				sourcePicker={pickerFor(i)}
				onActivate={() => setActive(i)}
			/>
		) : (
			libraryPane(i)
		);
	};

	return (
		<main className="flex h-full flex-col">
			{header}
			<DragProvider onTransfer={transfer.onTransfer}>
				<div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<HealthBar
						error={audit.isError ? String(audit.error) : null}
						notice={notice}
						onDismiss={() => setNotice(null)}
					/>
					<NoticeBar notice={transfer.notice} onDismiss={transfer.dismiss} />
					<div className="flex min-h-0 flex-1">
						{panes.map((i) => (
							<div key={i} className="flex min-h-0 min-w-0 flex-1 flex-col">
								{pane(i)}
							</div>
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
					{transfer.dialog}
					{shortcuts && <FileShortcuts onClose={() => setShortcuts(false)} />}
				</div>
			</DragProvider>
		</main>
	);
}
