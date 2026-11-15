import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	importTrash,
	onImportProgress,
	pickImportFolder,
} from "#/lib/api.ts";
import {
	allKeys,
	applyAdded,
	buildRequests,
	type Edit,
	editOf,
	groupKey,
	mergeEdits,
	previewTrack,
	srcKey,
	trackKey,
	trashTargets,
} from "#/lib/import-state.ts";
import { useLibraryRoot } from "#/lib/queries.ts";
import { applyClick, EMPTY_SELECTION, type Modifiers, type Selection } from "#/lib/selection.ts";

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

/** Asks for the Downloads folder and shares the choice with every view of it. */
export function useChooseImportFolder() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: pickImportFolder,
		onSuccess: (dir) => {
			if (dir !== null) {
				queryClient.setQueryData(["import-folder"], dir);
			}
		},
	});
}

export function useImport(enabled = true) {
	const queryClient = useQueryClient();
	const savedFolder = useQuery({ queryKey: ["import-folder"], queryFn: importGetFolder });
	const root = useLibraryRoot();
	const folder = savedFolder.data ?? null;

	const [scan, setScan] = useState<ImportScan | null>(null);
	const [fromCache, setFromCache] = useState(false);
	const [edits, setEdits] = useState<Record<string, Edit>>({});
	// Nothing is picked until you pick it, as in a file browser.
	const [selection, setSelection] = useState<Selection<string>>(EMPTY_SELECTION);
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
		if (!enabled || folder === null || booted.current === folder) {
			return;
		}
		if (booted.current !== null) {
			setScan(null);
			setReport(null);
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
	}, [enabled, folder, show, startScan]);

	const choose = useChooseImportFolder();

	/** Imports the given tracks (by key). Imported tracks flip to "in library" and leave the selection. */
	const add = useMutation({
		mutationFn: async (keys: ReadonlySet<string>) => {
			if (folder === null) {
				throw new Error("no folder chosen");
			}
			const requests = buildRequests(scan, edits, keys);
			const done = await importRun(folder, requests);
			return { done, sent: requests.flatMap((r) => r.tracks) };
		},
		onSuccess: async ({ done, sent }) => {
			setReport(done);
			const failed = new Set(done.failed.map((f) => f.file));
			const ok = new Set(sent.filter((s) => !failed.has(s.entry ?? s.path)).map(srcKey));
			setScan((prev) => prev && applyAdded(prev, ok));
			setSelection((prev) => ({
				selected: new Set([...prev.selected].filter((k) => !ok.has(k))),
				anchor: null,
			}));
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
			await queryClient.invalidateQueries({ queryKey: ["library-status"] });
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

	// Every track in list order, for shift-click ranges. Any track can be picked (to move it to
	// the Trash); only new ones are imported.
	const order = useMemo(() => (scan?.groups ?? []).flatMap(allKeys), [scan]);
	const selected = useMemo(() => {
		const present = new Set(order);
		return new Set([...selection.selected].filter((k) => present.has(k)));
	}, [order, selection.selected]);

	const importable = useMemo(() => {
		const fresh = new Set(
			(scan?.groups ?? []).flatMap((g) => g.tracks.filter((t) => t.status === "new").map(trackKey)),
		);
		return new Set([...selected].filter((k) => fresh.has(k)));
	}, [scan, selected]);

	/** Moves the given tracks' files (or whole folders and zips) to the Trash, then rescans. */
	const trash = useMutation({
		mutationFn: async (keys: ReadonlySet<string>) => {
			const { paths, kept } = trashTargets(scan, keys, folder);
			if (paths.length === 0) {
				return { moved: 0, kept };
			}
			await importTrash(paths);
			return { moved: paths.length, kept };
		},
		onSuccess: ({ moved }) => {
			setSelection(EMPTY_SELECTION);
			if (moved > 0 && folder !== null) {
				startScan({ dir: folder, fresh: false });
			}
		},
	});

	return {
		folder,
		scan,
		fromCache,
		edits,
		selected,
		/** Picked tracks that can be imported. */
		importable,
		trash,
		report,
		find,
		choose,
		add,
		preview,
		canAdd: root.data !== null,
		hasRoot: root.data !== null,
		rescan: (fresh: boolean) => enabled && folder !== null && startScan({ dir: folder, fresh }),
		edit: (key: string, next: { artist: string; album: string }) =>
			setEdits((prev) => ({ ...prev, [key]: { ...next, touched: true } })),
		/** Finder-style click: one, ⌘ to add or remove, ⇧ for a range. */
		click: (key: string, mods: Modifiers) =>
			setSelection((prev) => applyClick(prev, order, key, mods)),
		/** A checkbox: adds or removes one without touching the rest. */
		toggle: (key: string) =>
			setSelection((prev) => applyClick(prev, order, key, { shift: false, toggle: true })),
		/** Picks or drops every new track of these keys (a release's checkbox). */
		setMany: (keys: readonly string[], on: boolean) =>
			setSelection((prev) => {
				const next = new Set(prev.selected);
				for (const k of keys) {
					if (on) {
						next.add(k);
					} else {
						next.delete(k);
					}
				}
				return { selected: next, anchor: prev.anchor };
			}),
		selectAll: () => setSelection({ selected: new Set(order), anchor: null }),
		clearSelection: () => setSelection(EMPTY_SELECTION),
	};
}
