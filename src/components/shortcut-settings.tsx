import { Popover, PopoverTrigger } from "@ui-sdk/react/popover";
import {
	Compass,
	Flag,
	FolderTree,
	Grid3x3,
	Keyboard,
	ListMusic,
	MoveHorizontal,
	Plus,
	RotateCcw,
	Scissors,
	Trash2,
	TriangleAlert,
	Wrench,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { FrameSection } from "#/components/frame.tsx";
import { Button } from "#/components/ui/button.tsx";
import { GrowPopup } from "#/components/ui/popup.tsx";
import { keyLabel } from "#/lib/platform.ts";
import {
	assign,
	type Bindings,
	type Chord,
	chordLabel,
	chordOf,
	chordParts,
	conflictsWith,
	type Held,
	isCustom,
	modifierCaps,
	reservedFor,
	resetOne,
	SHORTCUTS,
	type ShortcutDef,
	type ShortcutId,
	type ShortcutScope,
	shortcutDef,
	unbind,
} from "#/lib/shortcuts.ts";
import {
	getOverrides,
	setOverrides,
	setRecording,
	useBindings,
	useMacLabels,
} from "#/lib/use-shortcuts.ts";
import { cn } from "#/lib/utils.ts";

/** The card that is open: which action, and which of its keys it replaces (null adds one). */
interface Editing {
	id: ShortcutId;
	replacing: Chord | null;
}

/** How long a saved key stays lit in the card before it closes. */
const SAVED_FOR_MS = 450;

/** When each kind of shortcut listens; the same words under every section of that kind. */
const WHEN: Record<ShortcutScope, string> = {
	app: "Always, except while typing",
	deck: "The waveform is shown",
	files: "The file browser has focus",
	list: "A song list or a grid of albums or artists has focus (J or K from the page goes there)",
};

const ICON = "size-4 text-muted-foreground";

/** Settings' sections, in order: one per group of `SHORTCUTS`. */
const SECTIONS: readonly { scope: ShortcutScope; group: string; title: string; icon: ReactNode }[] =
	[
		{ scope: "app", group: "Anywhere", title: "General", icon: <Keyboard className={ICON} /> },
		{ scope: "app", group: "Go to", title: "Pages", icon: <Compass className={ICON} /> },
		{
			scope: "list",
			group: "Song lists",
			title: "Lists and grids",
			icon: <ListMusic className={ICON} />,
		},
		{
			scope: "deck",
			group: "Move",
			title: "Playhead and zoom",
			icon: <MoveHorizontal className={ICON} />,
		},
		{ scope: "deck", group: "Beat grid", title: "Beat grid", icon: <Grid3x3 className={ICON} /> },
		{ scope: "deck", group: "Cues", title: "Cues", icon: <Flag className={ICON} /> },
		{
			scope: "files",
			group: "Move around",
			title: "Browsing",
			icon: <FolderTree className={ICON} />,
		},
		{ scope: "files", group: "Organize", title: "Organizing", icon: <Scissors className={ICON} /> },
		{
			scope: "files",
			group: "Fix and tag",
			title: "Fixing and tagging",
			icon: <Wrench className={ICON} />,
		},
	];

/** A section's "when" line: the label, then the condition. */
function When({ children }: { children: ReactNode }) {
	return (
		<span className="flex items-center gap-2">
			<span className="rounded bg-foreground/[0.06] px-1.5 py-px font-medium text-[11px] text-muted-foreground">
				When
			</span>
			<span>{children}</span>
		</span>
	);
}

/** Every keyboard shortcut, by where it works; the bindable ones can be changed here. */
export function ShortcutSettings() {
	const bindings = useBindings();
	const [editing, setEditing] = useState<Editing | null>(null);
	const customised = SHORTCUTS.some((s) => isCustom(bindings, s.id));
	const rows = { bindings, editing, onEdit: setEditing };

	return (
		<>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<p className="max-w-prose text-muted-foreground text-sm">
					Click a shortcut to record a new one. Kept on this computer only.
				</p>
				{customised && (
					<Button variant="ghost" size="sm" onClick={() => setOverrides({})}>
						<RotateCcw /> Reset all
					</Button>
				)}
			</div>
			{SECTIONS.map((section) => (
				<FrameSection
					key={section.group}
					icon={section.icon}
					title={section.title}
					description={<When>{WHEN[section.scope]}</When>}
				>
					{SHORTCUTS.filter((s) => s.scope === section.scope && s.group === section.group).map(
						(def) => (
							<ShortcutRow key={def.id} def={def} {...rows} />
						),
					)}
				</FrameSection>
			))}
		</>
	);
}

/** Keycaps in a row, as on the keyboard. `size` "lg" is the recorder's stage. */
function Caps({
	caps,
	size = "sm",
	tone = "plain",
}: {
	caps: readonly string[];
	size?: "sm" | "lg";
	tone?: "plain" | "lit" | "warn";
}) {
	return (
		<span className={cn("flex items-center", size === "lg" ? "gap-1.5" : "gap-0.5")}>
			{caps.map((cap, i) => (
				<kbd
					// biome-ignore lint/suspicious/noArrayIndexKey: a chord's caps are a fixed sequence
					key={i}
					className={cn(
						"grid place-items-center rounded-md border border-b-2 font-sans tabular-nums transition-colors duration-150",
						size === "lg"
							? "h-10 min-w-10 rounded-lg border-b-[3px] px-2.5 font-medium text-base"
							: "h-6 min-w-6 px-1.5 text-xs",
						tone === "plain" && "border-foreground/15 bg-background text-foreground",
						tone === "lit" && "border-primary/70 bg-primary text-primary-foreground",
						tone === "warn" && "border-warning/60 bg-warning/10 text-warning",
					)}
				>
					{cap}
				</kbd>
			))}
		</span>
	);
}

function ShortcutRow({
	def,
	bindings,
	editing,
	onEdit,
}: {
	def: ShortcutDef;
	bindings: Bindings;
	editing: Editing | null;
	onEdit: (e: Editing | null) => void;
}) {
	const mac = useMacLabels();
	const keys = bindings.get(def.id) ?? [];
	const isOpen = (replacing: Chord | null) =>
		editing?.id === def.id && editing.replacing === replacing;
	// Two actions on one key (left by an older version or a hand edit): the first listed wins.
	const shared = keys.flatMap((k) => conflictsWith(bindings, def.id, k));

	return (
		<div className="px-4 py-2">
			<div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
				<span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
					{def.label}
					{def.fineWithAlt && (
						<span className="text-muted-foreground text-xs">{keyLabel("⌥ for finer steps")}</span>
					)}
				</span>
				<div className="flex flex-wrap items-center justify-end gap-1">
					{keys.length === 0 && <span className="px-1 text-muted-foreground text-xs">None</span>}
					{keys.map((chord) => (
						<RecorderCard
							key={chord}
							def={def}
							replacing={chord}
							bindings={bindings}
							open={isOpen(chord)}
							onOpenChange={(open) => onEdit(open ? { id: def.id, replacing: chord } : null)}
							trigger={
								<PopoverTrigger
									aria-label={`Change ${chordLabel(chord, mac)} for ${def.label}`}
									className="rounded-lg p-1 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 data-[open]:bg-primary/10"
								>
									<Caps caps={chordParts(chord, mac)} />
								</PopoverTrigger>
							}
						/>
					))}
					<RecorderCard
						def={def}
						replacing={null}
						bindings={bindings}
						open={isOpen(null)}
						onOpenChange={(open) => onEdit(open ? { id: def.id, replacing: null } : null)}
						trigger={
							<PopoverTrigger
								aria-label={`Add a key for ${def.label}`}
								data-hint="Add a key"
								className="grid size-8 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[open]:bg-primary/10 data-[open]:text-primary [&_svg]:size-3.5"
							>
								<Plus />
							</PopoverTrigger>
						}
					/>
				</div>
			</div>
			{shared.length > 0 && (
				<p className="mt-1 flex items-center gap-1.5 text-warning text-xs">
					<TriangleAlert className="size-3.5 shrink-0" />
					Shares a key with {shared.map((id) => `“${shortcutDef(id).label}”`).join(", ")}.
				</p>
			)}
		</div>
	);
}

/** Where the recorder is: waiting for keys, holding a key something else uses, or saved. */
type Stage =
	| { kind: "listening" }
	| { kind: "clash"; chord: Chord; takenBy: readonly ShortcutId[]; reserved: string | null }
	| { kind: "saved"; chord: Chord };

const NOTHING_HELD: Held = { mod: false, alt: false, shift: false };
const heldOf = (e: KeyboardEvent): Held => ({
	mod: e.metaKey || e.ctrlKey,
	alt: e.altKey,
	shift: e.shiftKey,
});

/**
 * Listens while the card waits for keys: the modifiers held light up as they go down, and the
 * first full chord is handed on. Escape closes the card. No other shortcut runs meanwhile.
 */
function useRecorder(
	listening: boolean,
	ignoreAlt: boolean,
	onHeld: (held: Held) => void,
	onChord: (chord: Chord) => void,
	onCancel: () => void,
) {
	useEffect(() => {
		if (!listening) {
			return;
		}
		setRecording(true);
		const onDown = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopImmediatePropagation();
			if (e.key === "Escape") {
				onCancel();
				return;
			}
			onHeld(heldOf(e));
			const chord = chordOf(e, { ignoreAlt });
			if (chord) {
				onChord(chord);
			}
		};
		const onUp = (e: KeyboardEvent) => onHeld(heldOf(e));
		window.addEventListener("keydown", onDown, true);
		window.addEventListener("keyup", onUp, true);
		return () => {
			window.removeEventListener("keydown", onDown, true);
			window.removeEventListener("keyup", onUp, true);
			setRecording(false);
		};
	}, [listening, ignoreAlt, onHeld, onChord, onCancel]);
}

/**
 * The card a shortcut grows into when clicked, after Raycast's hotkey recorder: the keys show as
 * big keycaps while held, a free key saves at once, and one already in use says what will lose it.
 */
function RecorderCard({
	def,
	replacing,
	bindings,
	open,
	onOpenChange,
	trigger,
}: {
	def: ShortcutDef;
	replacing: Chord | null;
	bindings: Bindings;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger: ReactNode;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{trigger}
			{/* Grows out of the keys it changes, over the row, instead of opening beside them. */}
			<GrowPopup overlap={36} align="end" className="w-80 p-3">
				{open && (
					<Recorder
						def={def}
						replacing={replacing}
						bindings={bindings}
						onClose={() => onOpenChange(false)}
					/>
				)}
			</GrowPopup>
		</Popover>
	);
}

function Recorder({
	def,
	replacing,
	bindings,
	onClose,
}: {
	def: ShortcutDef;
	replacing: Chord | null;
	bindings: Bindings;
	onClose: () => void;
}) {
	const mac = useMacLabels();
	const [stage, setStage] = useState<Stage>({ kind: "listening" });
	const [held, setHeld] = useState<Held>(NOTHING_HELD);

	const save = (chord: Chord) => {
		setOverrides(assign(getOverrides(), def.id, chord, replacing));
		setStage({ kind: "saved", chord });
	};
	const onChord = (chord: Chord) => {
		if (chord === replacing) {
			onClose();
			return;
		}
		const takenBy = conflictsWith(bindings, def.id, chord);
		const reserved = reservedFor(chord, def.id);
		if (takenBy.length > 0 || reserved !== null) {
			setStage({ kind: "clash", chord, takenBy, reserved });
		} else {
			save(chord);
		}
	};
	useRecorder(stage.kind === "listening", def.fineWithAlt === true, setHeld, onChord, onClose);

	useEffect(() => {
		if (stage.kind !== "saved") {
			return;
		}
		const timer = setTimeout(onClose, SAVED_FOR_MS);
		return () => clearTimeout(timer);
	}, [stage, onClose]);

	const live = modifierCaps(held, mac);
	return (
		<div className="space-y-3">
			<div className="flex items-baseline justify-between gap-3 px-0.5">
				<span className="truncate font-medium text-sm">{def.label}</span>
				<span className="shrink-0 text-muted-foreground text-xs">
					{replacing ? `Replacing ${chordLabel(replacing, mac)}` : "New key"}
				</span>
			</div>

			<div
				className={cn(
					"grid h-20 place-items-center rounded-lg border bg-muted/40 transition-colors",
					stage.kind === "clash" && "border-warning/40 bg-warning/5",
				)}
			>
				{stage.kind === "listening" &&
					(live.length > 0 ? (
						<Caps caps={[...live, "…"]} size="lg" />
					) : (
						<span className="flex items-center gap-2 text-muted-foreground text-sm">
							<span className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
							Press a shortcut
						</span>
					))}
				{stage.kind === "clash" && (
					<span className="animate-keycap-shake motion-reduce:animate-none">
						<Caps caps={chordParts(stage.chord, mac)} size="lg" tone="warn" />
					</span>
				)}
				{stage.kind === "saved" && (
					<Caps caps={chordParts(stage.chord, mac)} size="lg" tone="lit" />
				)}
			</div>

			{stage.kind === "clash" ? (
				<div className="space-y-2.5">
					<p className="flex gap-1.5 text-warning text-xs leading-relaxed">
						<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
						<span>{clashText(stage)}</span>
					</p>
					<div className="flex justify-end gap-1.5">
						<Button size="sm" variant="ghost" onClick={() => setStage({ kind: "listening" })}>
							Try another
						</Button>
						<Button size="sm" onClick={() => save(stage.chord)}>
							Use anyway
						</Button>
					</div>
				</div>
			) : (
				<div className="flex min-h-7 items-center justify-between gap-2 text-muted-foreground text-xs">
					<span className="flex items-center gap-1">
						<Caps caps={["esc"]} /> to cancel
					</span>
					<RecorderActions def={def} replacing={replacing} bindings={bindings} onDone={onClose} />
				</div>
			)}
		</div>
	);
}

/** Taking the key off, or back to the action's keys out of the box. */
function RecorderActions({
	def,
	replacing,
	bindings,
	onDone,
}: {
	def: ShortcutDef;
	replacing: Chord | null;
	bindings: Bindings;
	onDone: () => void;
}) {
	return (
		<span className="flex gap-0.5">
			{isCustom(bindings, def.id) && (
				<Button
					size="xs"
					variant="ghost"
					onClick={() => {
						setOverrides(resetOne(getOverrides(), def.id));
						onDone();
					}}
				>
					<RotateCcw /> Default
				</Button>
			)}
			{replacing && (
				<Button
					size="xs"
					variant="ghost"
					className="hover:text-destructive"
					onClick={() => {
						setOverrides(unbind(getOverrides(), def.id, replacing));
						onDone();
					}}
				>
					<Trash2 /> Remove
				</Button>
			)}
		</span>
	);
}

/** What a clash means, and what "Use anyway" will do about it. */
function clashText(clash: Extract<Stage, { kind: "clash" }>): string {
	const others = clash.takenBy.map((id) => `“${shortcutDef(id).label}”`).join(" and ");
	if (clash.reserved && others) {
		return `This is ${clash.reserved.toLowerCase()} in the app or system, and ${others}, which will lose it.`;
	}
	if (clash.reserved) {
		return `This is ${clash.reserved.toLowerCase()} in the app or system; this shortcut would take it over.`;
	}
	return `Already ${others}, which will lose it.`;
}
