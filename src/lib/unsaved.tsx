import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";

/** What a drawer's content tells the drawer about changes it has not saved yet. */
export interface Unsaved {
	/** Changes exist that are not saved. */
	dirty: boolean;
	/** Short name for the confirmation ("Beat grid and cues"). */
	label: string;
	/** Saves now; resolves true when saved. Absent when the changes cannot be saved as they are. */
	save?: (() => Promise<boolean>) | undefined;
	/** Saved on its own (autosave): closing saves it first and only asks if that fails. */
	autosave: boolean;
	/** Why the last save failed, or why it cannot be saved. */
	error?: string | null | undefined;
}

type Registry = Map<string, () => Unsaved>;

const UnsavedContext = createContext<Registry | null>(null);

/**
 * Tells the enclosing drawer about this component's unsaved changes, while it is mounted. Pass a
 * function to have it read at the moment the drawer asks, rather than as of the last render.
 */
export function useUnsaved(state: Unsaved | (() => Unsaved)) {
	const registry = useContext(UnsavedContext);
	const id = useId();
	const latest = useRef(state);
	latest.current = state;
	useEffect(() => {
		if (!registry) {
			return;
		}
		registry.set(id, () => {
			const now = latest.current;
			return typeof now === "function" ? now() : now;
		});
		return () => {
			registry.delete(id);
		};
	}, [registry, id]);
}

/**
 * For a drawer: `guard(proceed)` runs `proceed` (close, go back, open something else) once the
 * changes inside are safe. Autosaved changes are saved first; anything still unsaved after that
 * (a failed save, or changes saved only by hand) is put to the user. Render `dialog` and wrap the
 * drawer's content in `Provider`.
 */
export function useUnsavedGuard() {
	const registry = useMemo<Registry>(() => new Map(), []);
	const [asking, setAsking] = useState<{ open: Unsaved[]; proceed: () => void } | null>(null);
	const [saving, setSaving] = useState(false);

	const dirty = useCallback(
		() => [...registry.values()].map((get) => get()).filter((u) => u.dirty),
		[registry],
	);

	const guard = useCallback(
		async (proceed: () => void) => {
			let open = dirty();
			if (open.length === 0) {
				proceed();
				return;
			}
			for (const u of open) {
				if (u.autosave && u.save) {
					await u.save();
				}
			}
			open = dirty();
			if (open.length === 0) {
				proceed();
			} else {
				setAsking({ open, proceed });
			}
		},
		[dirty],
	);

	const Provider = useCallback(
		({ children }: { children: ReactNode }) => (
			<UnsavedContext.Provider value={registry}>{children}</UnsavedContext.Provider>
		),
		[registry],
	);

	const savable = asking?.open.every((u) => u.save !== undefined) ?? false;
	const dialog = asking && (
		<ConfirmDialog
			title="Unsaved changes"
			confirmLabel={savable ? (saving ? "Saving…" : "Save") : "Discard"}
			destructive={!savable}
			busy={saving}
			onCancel={() => setAsking(null)}
			extra={
				savable && (
					<Button
						variant="ghost"
						onClick={() => {
							asking.proceed();
							setAsking(null);
						}}
					>
						Discard
					</Button>
				)
			}
			onConfirm={async () => {
				if (!savable) {
					asking.proceed();
					setAsking(null);
					return;
				}
				setSaving(true);
				const ok = (await Promise.all(asking.open.map((u) => u.save?.() ?? false))).every(Boolean);
				setSaving(false);
				if (ok) {
					asking.proceed();
					setAsking(null);
				} else {
					setAsking({ ...asking, open: dirty() });
				}
			}}
		>
			<ul className="space-y-1">
				{asking.open.map((u) => (
					<li key={u.label}>
						<span className="text-foreground">{u.label}</span>
						{u.error ? <span className="text-destructive"> · {u.error}</span> : " not saved yet"}
					</li>
				))}
			</ul>
		</ConfirmDialog>
	);

	return { guard, dialog, Provider };
}

export type SaveStatus = "saved" | "pending" | "saving" | "error" | "invalid";

/**
 * Saves `value` a second after it last changed, whenever it differs from `saved` and `canSave`
 * allows it. Leaving the component (closing the drawer, moving to another song) saves what is
 * pending straight away. Registers with the enclosing drawer so closing it waits for the save
 * and asks only when the changes could not be saved.
 */
export function useAutosave<T>({
	value,
	saved,
	equal,
	save,
	canSave = () => true,
	label,
	delay = 1000,
}: {
	value: T;
	saved: T;
	equal: (a: T, b: T) => boolean;
	/** Writes `value`; throws to report a failure. */
	save: (value: T) => Promise<unknown>;
	canSave?: (value: T) => boolean;
	label: string;
	delay?: number;
}) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dirty = !equal(value, saved);
	const valid = canSave(value);

	// Bumped when the value really changes, not on every render (callers build it afresh), so
	// the countdown restarts only on an edit.
	const changes = useRef({ value, count: 0 });
	if (!equal(value, changes.current.value)) {
		changes.current = { value, count: changes.current.count + 1 };
	}
	const revision = changes.current.count;
	const latest = useRef({ value, saved, equal, save, canSave });
	latest.current = { value, saved, equal, save, canSave };
	const running = useRef<Promise<boolean> | null>(null);
	/** The last value written, so leaving right after a save does not write it again. */
	const sent = useRef<{ value: T } | null>(null);
	const failure = useRef<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flush = useCallback(async (): Promise<boolean> => {
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		// One save at a time: wait for the one in flight, then see what is still to save.
		if (running.current) {
			await running.current;
		}
		const now = latest.current;
		if (now.equal(now.value, now.saved)) {
			return true;
		}
		if (!now.canSave(now.value)) {
			return false;
		}
		const run = (async () => {
			setSaving(true);
			try {
				await now.save(now.value);
				sent.current = { value: now.value };
				failure.current = null;
				setError(null);
				return true;
			} catch (e) {
				failure.current = e instanceof Error ? e.message : String(e);
				setError(failure.current);
				return false;
			} finally {
				setSaving(false);
				running.current = null;
			}
		})();
		running.current = run;
		return run;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` restarts the countdown on each edit
	useEffect(() => {
		if (!dirty || !valid) {
			return;
		}
		timer.current = setTimeout(() => void flush(), delay);
		return () => {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
		};
	}, [revision, dirty, valid, delay, flush]);

	// Unmounting with a save still pending saves it now rather than dropping it.
	useEffect(
		() => () => {
			const now = latest.current;
			const written = sent.current !== null && now.equal(now.value, sent.current.value);
			if (!written && !now.equal(now.value, now.saved) && now.canSave(now.value)) {
				void now.save(now.value).catch(() => undefined);
			}
		},
		[],
	);

	let status: SaveStatus = "saved";
	if (saving) {
		status = "saving";
	} else if (dirty && !valid) {
		status = "invalid";
	} else if (dirty && error) {
		status = "error";
	} else if (dirty) {
		status = "pending";
	}

	// Read when the drawer asks: a save that just finished counts even before the next render.
	useUnsaved(() => {
		const now = latest.current;
		const written = sent.current !== null && now.equal(now.value, sent.current.value);
		return {
			dirty: !written && !now.equal(now.value, now.saved),
			label,
			autosave: true,
			error: failure.current,
			save: now.canSave(now.value) ? flush : undefined,
		};
	});

	return { status, error, flush, dirty };
}
