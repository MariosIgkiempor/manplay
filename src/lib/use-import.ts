import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlayer } from "#/context/player-context.ts";
import {
	type ImportProgress,
	type ImportReport,
	type ImportScan,
	type ImportTrack,
	importCached,
	importGetFolder,
	importPreview,
	importRun,
	importScan,
	onImportProgress,
	pickImportFolder,
} from "#/lib/api.ts";
import {
	applyAdded,
	buildRequests,
	type Edit,
	editOf,
	groupKey,
	mergeEdits,
	previewTrack,
	srcKey,
	trackKey,
	withAll,
	withToggled,
} from "#/lib/import-state.ts";
import { useLibraryRoot, useSyncRun, useSyncTargets } from "#/lib/queries.ts";

/** Live progress of the running scan, or null when idle. */
export function useImportProgress(active: boolean): ImportProgress | null {
	const [progress, setProgress] = useState<ImportProgress | null>(null);
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void onImportProgress(setProgress).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);
	return active ? progress : null;
}

/** Plays import candidates through the app player (zip entries are extracted first). */
function usePreview(folder: string | null, editFor: (key: string) => Edit | undefined) {
	const player = usePlayer();
	const [loaded, setLoaded] = useState<{ key: string; path: string } | null>(null);
	const [loading, setLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeKey = loaded && player.current?.path === loaded.path ? loaded.key : null;

	const toggle = useCallback(
		async (groupId: string, t: ImportTrack) => {
			const key = trackKey(t);
			if (activeKey === key) {
				player.toggle();
				return;
			}
			const edit = editFor(groupId);
			if (folder === null || edit === undefined) {
				return;
			}
			setLoading(key);
			setError(null);
			try {
				const path = await importPreview(folder, t.src);
				player.play([previewTrack(path, t, edit)], 0);
				setLoaded({ key, path });
			} catch (e) {
				setError(String(e));
			} finally {
				setLoading(null);
			}
		},
		[activeKey, editFor, folder, player],
	);

	return { activeKey, isPlaying: player.playing, loading, error, toggle };
}

export function useImport() {
	const queryClient = useQueryClient();
	const savedFolder = useQuery({ queryKey: ["import-folder"], queryFn: importGetFolder });
	const root = useLibraryRoot();
	const targets = useSyncTargets();
	const sync = useSyncRun();
	const [picked, setPicked] = useState<string | null>(null);
	const folder = picked ?? savedFolder.data ?? null;

	const [scan, setScan] = useState<ImportScan | null>(null);
	const [fromCache, setFromCache] = useState(false);
	const [edits, setEdits] = useState<Record<string, Edit>>({});
	const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
	const [report, setReport] = useState<ImportReport | null>(null);

	const show = useCallback((next: ImportScan, cached: boolean) => {
		setScan(next);
		setFromCache(cached);
		setEdits((prev) => mergeEdits(prev, next.groups));
	}, []);

	const find = useMutation({
		mutationFn: ({ dir, fresh }: { dir: string; fresh: boolean }) => importScan(dir, fresh),
		onSuccess: (next) => show(next, false),
	});
	const { mutate: startScan } = find;

	// Show what the last scan found right away, then bring it up to date.
	const booted = useRef<string | null>(null);
	useEffect(() => {
		if (folder === null || booted.current === folder) {
			return;
		}
		booted.current = folder;
		void importCached(folder).then((cached) => {
			if (cached !== null) {
				setScan((prev) => {
					if (prev === null) {
						show(cached, true);
					}
					return prev;
				});
			}
		});
		startScan({ dir: folder, fresh: false });
	}, [folder, show, startScan]);

	const choose = useMutation({
		mutationFn: pickImportFolder,
		onSuccess: (dir) => {
			if (dir !== null) {
				setPicked(dir);
				setReport(null);
				setScan(null);
			}
		},
	});

	/** Adds one group (by key) or all of them (null). Imported tracks flip to "in library". */
	const add = useMutation({
		mutationFn: async (only: string | null) => {
			if (folder === null) {
				throw new Error("no folder chosen");
			}
			const requests = buildRequests(scan, edits, unchecked, only);
			const done = await importRun(folder, requests);
			return { done, sent: requests.flatMap((r) => r.tracks) };
		},
		onSuccess: async ({ done, sent }) => {
			setReport(done);
			const failed = new Set(done.failed.map((f) => f.file));
			const ok = new Set(sent.filter((s) => !failed.has(s.entry ?? s.path)).map(srcKey));
			setScan((prev) => prev && applyAdded(prev, ok));
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
			if (done.imported > 0 && (targets.data?.length ?? 0) > 0) {
				sync.mutate(undefined);
			}
		},
	});

	const editFor = useCallback(
		(key: string) => scan?.groups.map((g) => ({ g, key: groupKey(g) })).find((x) => x.key === key),
		[scan],
	);
	const preview = usePreview(folder, (key) => {
		const hit = editFor(key);
		return hit && editOf(edits, hit.g);
	});

	return {
		folder,
		scan,
		fromCache,
		edits,
		unchecked,
		report,
		find,
		choose,
		add,
		preview,
		canAdd: root.data !== null,
		hasRoot: root.data !== null,
		rescan: (fresh: boolean) => folder !== null && startScan({ dir: folder, fresh }),
		edit: (key: string, next: { artist: string; album: string }) =>
			setEdits((prev) => ({ ...prev, [key]: { ...next, touched: true } })),
		toggle: (key: string) => setUnchecked((prev) => withToggled(prev, key)),
		toggleAll: (g: Parameters<typeof withAll>[1], on: boolean) =>
			setUnchecked((prev) => withAll(prev, g, on)),
	};
}
