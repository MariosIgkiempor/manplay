import {
	createContext,
	type DragEvent,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { setDragImage } from "#/lib/drag-image.ts";
import {
	type DragItem,
	type DragSession,
	type DropDest,
	type DropOp,
	dropOp,
	type PaneSource,
	sameSource,
} from "#/lib/drag-session.ts";

/** Marks drags that start in a file pane, so other drags (files from Finder) are left alone. */
const DRAG_TYPE = "application/x-manplay-rows";

/** How long a dragged item rests on a closed folder before it opens. */
const SPRING_MS = 650;

interface DragState {
	session: DragSession | null;
	over: DropDest | null;
	begin: (session: DragSession) => void;
	end: () => void;
	setOver: (dest: DropDest | null) => void;
	/** Carries out a drop that is not a plain move inside the library. */
	transfer: (session: DragSession, dest: DropDest, op: DropOp) => void;
}

const DragContext = createContext<DragState | null>(null);

/** Shares the drag in progress between every file pane, so a drop can land in another pane. */
export function DragProvider({
	onTransfer,
	children,
}: {
	onTransfer: (session: DragSession, dest: DropDest, op: DropOp) => void;
	children: ReactNode;
}) {
	const [session, setSession] = useState<DragSession | null>(null);
	const [over, setOver] = useState<DropDest | null>(null);
	const transferRef = useRef(onTransfer);
	transferRef.current = onTransfer;
	const value = useMemo<DragState>(
		() => ({
			session,
			over,
			begin: setSession,
			end: () => {
				setSession(null);
				setOver(null);
			},
			setOver,
			transfer: (s, d, op) => transferRef.current(s, d, op),
		}),
		[session, over],
	);
	return <DragContext.Provider value={value}>{children}</DragContext.Provider>;
}

interface Options {
	pane: 0 | 1;
	source: PaneSource;
	/** The row at `path`, for the drag picture and the transfer. */
	describe: (path: string) => DragItem | undefined;
	selected: ReadonlySet<string>;
	/** Called when an unselected row starts dragging, so the drag acts on just that row. */
	selectOnly: (path: string) => void;
	/** A plain move between two library folders, which the pane runs itself (with undo). */
	onLibraryMove?: (paths: string[], dest: string) => void;
	/** Opens a folder the drag has rested on; `null` when `path` is not a closed folder. */
	spring?: { isClosedFolder: (path: string) => boolean; open: (path: string) => void };
}

/** What dropping would do, for the hint shown over the pane. */
export interface DropHint {
	op: DropOp;
	count: number;
	/** The folder's name, or the pane's own name for its top folder. */
	into: string;
}

/**
 * Drag and drop of rows onto folders, across panes: what is dragged, which folder is the drop
 * target, what a drop there would do, and which rows to show as being carried.
 */
export function useFileDrag({
	pane,
	source,
	describe,
	selected,
	selectOnly,
	onLibraryMove,
	spring,
}: Options) {
	const ctx = useContext(DragContext);
	if (ctx === null) {
		throw new Error("useFileDrag must be used inside <DragProvider>");
	}
	const { session, over, begin, end, setOver, transfer } = ctx;
	const here = over !== null && over.pane === pane ? over : null;

	const springRef = useRef(spring);
	springRef.current = spring;
	const hoverPath = here?.path ?? null;
	useEffect(() => {
		const s = springRef.current;
		if (hoverPath === null || !s?.isClosedFolder(hoverPath)) {
			return;
		}
		const t = setTimeout(() => s.open(hoverPath), SPRING_MS);
		return () => clearTimeout(t);
	}, [hoverPath]);

	const destOf = (path: string): DropDest => ({ pane, source, path });

	return {
		/** The row or folder a drop would land in, in this pane. */
		dropTarget: here?.path ?? null,
		/** What a drop on `dropTarget` would do. */
		dropOp: session !== null && here !== null ? dropOp(session, here) : null,
		/** Paths of the rows from this pane that are being carried. */
		carried: useMemo<ReadonlySet<string>>(
			() =>
				session !== null && sameSource(session.source, source)
					? new Set(session.items.map((i) => i.path))
					: new Set(),
			[session, source],
		),
		/** What to tell the user a drop here would do; `into` names the folder it lands in. */
		hintFor: (into: (path: string) => string): DropHint | null => {
			const op = session !== null && here !== null ? dropOp(session, here) : null;
			return session !== null && here !== null && op !== null
				? { op, count: session.items.length, into: into(here.path) }
				: null;
		},
		session,
		/** Clears the target when the pointer leaves for somewhere outside `ev`'s element. */
		clearDrop: (ev?: DragEvent) => {
			if (ev?.relatedTarget instanceof Node && ev.currentTarget.contains(ev.relatedTarget)) {
				return;
			}
			setOver(null);
		},
		dragStart: (ev: DragEvent, path: string) => {
			if (!selected.has(path)) {
				selectOnly(path);
			}
			const paths = selected.has(path) ? [...selected] : [path];
			const items = paths.flatMap((p) => describe(p) ?? []);
			if (items.length === 0) {
				ev.preventDefault();
				return;
			}
			ev.dataTransfer.setData(DRAG_TYPE, "1");
			ev.dataTransfer.effectAllowed = "copyMove";
			setDragImage(ev.dataTransfer, items);
			begin({ source, items });
		},
		dragEnd: end,
		allowDrop: (ev: DragEvent, path: string) => {
			if (session === null || !ev.dataTransfer.types.includes(DRAG_TYPE)) {
				return;
			}
			const op = dropOp(session, destOf(path));
			if (op === null) {
				ev.dataTransfer.dropEffect = "none";
				// Keeps an outer folder from taking a drop its inner one refused.
				ev.stopPropagation();
				if (over !== null) {
					setOver(null);
				}
				return;
			}
			ev.preventDefault();
			ev.stopPropagation();
			ev.dataTransfer.dropEffect = op;
			if (over?.pane !== pane || over.path !== path) {
				setOver(destOf(path));
			}
		},
		dropInto: (ev: DragEvent, path: string) => {
			ev.preventDefault();
			ev.stopPropagation();
			const current = session;
			end();
			if (current === null) {
				return;
			}
			const dest = destOf(path);
			const op = dropOp(current, dest);
			if (op === null) {
				return;
			}
			if (op === "move" && current.source.kind === "library" && onLibraryMove) {
				onLibraryMove(
					current.items.map((i) => i.path),
					path,
				);
				return;
			}
			transfer(current, dest, op);
		},
	};
}
