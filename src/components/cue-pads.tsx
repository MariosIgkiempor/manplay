import { ContextMenu } from "@base-ui/react/context-menu";
import { Crosshair, Palette, PencilLine, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { InlineEdit, InlineInput } from "#/components/inline-edit.tsx";
import { type MenuEntry, MenuItems, MenuLabel } from "#/components/menu.tsx";
import { Section } from "#/components/page.tsx";
import { SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	beforeStart,
	CUE_COLORS,
	type Cue,
	MEMORY_COLOR,
	PAD_LETTERS,
	START_COLOR,
	stamp,
	startOf,
} from "#/lib/cues.ts";
import { popup } from "#/lib/menu-styles.ts";
import { cn } from "#/lib/utils.ts";

interface PadActions {
	/** Set, or move, hot cue `slot` to the playhead. */
	onSet: (slot: number) => void;
	onJump: (time: number) => void;
	onChange: (slot: number, patch: Partial<Cue>) => void;
	onDelete: (slot: number) => void;
}

function padMenu(cue: Cue, slot: number, a: PadActions, rename: () => void): MenuEntry[] {
	return [
		{ label: "Move to playhead", icon: <Crosshair />, onSelect: () => a.onSet(slot) },
		{ label: "Rename", icon: <PencilLine />, onSelect: rename },
		{
			label: "Colour",
			icon: <Palette />,
			items: CUE_COLORS.map((c) => ({
				label: c.name,
				icon: (
					<span
						className={cn(
							"size-3 rounded-sm ring-1 ring-foreground/20",
							cue.color === c.hex && "ring-2 ring-foreground",
						)}
						style={{ background: c.hex }}
					/>
				),
				onSelect: () => a.onChange(slot, { color: c.hex }),
			})),
		},
		"separator",
		{ label: "Delete", icon: <Trash2 />, destructive: true, onSelect: () => a.onDelete(slot) },
	];
}

/**
 * One pad, as on a CDJ: lit in its colour when set (press to jump there), dark and outlined
 * when free (press to set it at the playhead). Right-click a set pad for the rest.
 */
function Pad({ slot, cue, actions }: { slot: number; cue: Cue | undefined; actions: PadActions }) {
	const [renaming, setRenaming] = useState(false);
	const letter = PAD_LETTERS[slot] ?? "";
	if (!cue) {
		return (
			<button
				type="button"
				onClick={() => actions.onSet(slot)}
				title={`Set hot cue ${letter} at the playhead (${slot + 1})`}
				className="group flex h-16 flex-col justify-between rounded-md border border-foreground/15 border-dashed p-2 text-left outline-none transition-colors hover:border-foreground/40 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60"
			>
				<span className="font-semibold text-muted-foreground text-sm">{letter}</span>
				<span className="text-muted-foreground/0 text-xs transition-colors group-hover:text-muted-foreground">
					Set here
				</span>
			</button>
		);
	}
	const color = cue.color || CUE_COLORS[0].hex;
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger
				render={
					<div
						className="relative flex h-16 flex-col justify-between overflow-hidden rounded-md p-2 text-left"
						style={{
							background: `color-mix(in oklch, ${color} 22%, var(--card))`,
							boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 60%, transparent)`,
						}}
					/>
				}
			>
				<span className="absolute inset-x-0 top-0 h-1" style={{ background: color }} />
				<button
					type="button"
					onClick={() => actions.onJump(cue.start)}
					title={`Jump to hot cue ${letter} (${slot + 1})`}
					className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
					aria-label={`Jump to hot cue ${letter}`}
				/>
				<span className="pointer-events-none relative flex items-baseline justify-between gap-2">
					<span className="font-semibold text-sm" style={{ color }}>
						{letter}
					</span>
					<span className="text-[11px] text-muted-foreground tabular-nums">{stamp(cue.start)}</span>
				</span>
				{renaming ? (
					<span className="relative">
						<InlineInput
							initial={cue.name}
							label={`Name hot cue ${letter}`}
							className="h-6 text-xs"
							parse={(v) => v.trim()}
							onCancel={() => setRenaming(false)}
							onCommit={(name) => {
								setRenaming(false);
								actions.onChange(slot, { name });
							}}
						/>
					</span>
				) : (
					<span className="pointer-events-none relative truncate text-xs">
						{cue.name || <span className="text-muted-foreground">Hot cue {letter}</span>}
					</span>
				)}
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Positioner className="z-50">
					<ContextMenu.Popup className={popup} finalFocus={false}>
						<MenuLabel>Hot cue {letter}</MenuLabel>
						<MenuItems items={padMenu(cue, slot, actions, () => setRenaming(true))} />
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}

/** The eight hot cue pads, A–H. */
export function HotCuePads({ cues, actions }: { cues: readonly Cue[]; actions: PadActions }) {
	return (
		<Section title="Hot cues" count={cues.filter((c) => c.slot !== null).length}>
			<div className="grid grid-cols-4 gap-2 lg:grid-cols-8">
				{PAD_LETTERS.map((_, slot) => (
					<Pad
						// biome-ignore lint/suspicious/noArrayIndexKey: pads are fixed places A–H
						key={slot}
						slot={slot}
						cue={cues.find((c) => c.slot === slot)}
						actions={actions}
					/>
				))}
			</div>
		</Section>
	);
}

/** A memory cue's marker: a small diamond in its colour. */
function Marker({ color, start = false }: { color: string; start?: boolean }) {
	return start ? (
		<span
			aria-hidden
			className="size-0 border-x-[5px] border-x-transparent border-b-[8px]"
			style={{ borderBottomColor: color }}
		/>
	) : (
		<span aria-hidden className="size-2 rotate-45 rounded-[1px]" style={{ background: color }} />
	);
}

function TimeButton({ time, onJump }: { time: number; onJump: (t: number) => void }) {
	return (
		<button
			type="button"
			onClick={() => onJump(time)}
			title="Jump here"
			className="rounded-sm text-sm tabular-nums outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
		>
			{stamp(time)}
		</button>
	);
}

/**
 * Where the song starts (rekordbox's yellow main cue), for the transport bar: jumps there, or
 * to the grid's first beat while none is set. The CUE button sets it.
 */
export function StartCue({
	cues,
	firstBeat,
	onJump,
	onClear,
}: {
	cues: readonly Cue[];
	firstBeat: number;
	onJump: (time: number) => void;
	onClear: () => void;
}) {
	const start = startOf(cues);
	return (
		<div className="flex items-center rounded-md bg-white/5">
			<button
				type="button"
				onClick={() => onJump(start ? start.start : firstBeat)}
				title={
					start
						? "Where the song loads (rekordbox's main cue). Jump here."
						: "No start set: the song loads at the first beat. Press CUE to start it at the playhead."
				}
				className="flex items-center gap-2 rounded-md px-2 py-1 text-neutral-300 text-xs tabular-nums outline-none transition-colors hover:bg-white/10 hover:text-neutral-50 focus-visible:ring-2 focus-visible:ring-ring/60"
			>
				<Marker color={START_COLOR} start />
				{start ? stamp(start.start) : "First beat"}
			</button>
			{start && (
				<button
					type="button"
					aria-label="Clear the start"
					title="Clear the start"
					onClick={onClear}
					className="grid size-6 place-items-center rounded-md text-neutral-500 outline-none transition-colors hover:bg-white/10 hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3"
				>
					<X />
				</button>
			)}
		</div>
	);
}

/**
 * The memory cues, in time order. Players set to auto-cue on memory cues load the song at the
 * earliest one, so the start is exported as a memory cue and warned about when another comes
 * before it.
 */
export function MemoryCues({
	cues,
	onAdd,
	onJump,
	onRename,
	onDelete,
}: {
	cues: readonly Cue[];
	onAdd: () => void;
	onJump: (time: number) => void;
	onRename: (cue: Cue, name: string) => void;
	onDelete: (cue: Cue) => void;
}) {
	const list = cues.filter((c) => c.slot === null && !c.main).sort((a, b) => a.start - b.start);
	const early = beforeStart(cues)[0];
	return (
		<Section
			title="Memory cues"
			count={list.length}
			action={
				<Button
					size="sm"
					variant="ghost"
					title="Add a memory cue at the playhead (M)"
					onClick={onAdd}
				>
					<Plus /> Memory cue
				</Button>
			}
		>
			{list.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					None yet. Press M to add one at the playhead.
				</p>
			) : (
				<SettingRows>
					{list.map((c) => (
						<div key={`${c.start}`} className="group flex min-h-11 items-center gap-2.5 py-1.5">
							<Marker color={MEMORY_COLOR} />
							<TimeButton time={c.start} onJump={onJump} />
							<div className="min-w-0 flex-1">
								<InlineEdit
									value={c.name}
									label="Memory cue name"
									placeholder="Add a name"
									className="text-sm"
									parse={(v) => v.trim()}
									onCommit={(name) => onRename(c, name)}
								/>
							</div>
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label={`Remove memory cue at ${stamp(c.start)}`}
								title="Remove"
								className="opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
								onClick={() => onDelete(c)}
							>
								<X />
							</Button>
						</div>
					))}
				</SettingRows>
			)}
			{early && (
				<p className="flex items-center gap-2 text-warning text-xs">
					<TriangleAlert className="size-3.5 shrink-0" />
					The memory cue at {stamp(early.start)} comes first, so players will load the song there.
				</p>
			)}
		</Section>
	);
}
