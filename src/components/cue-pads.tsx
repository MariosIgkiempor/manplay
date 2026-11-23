import { MenuContextTrigger } from "@ui-sdk/react/menu";
import { Crosshair, Palette, PencilLine, Trash2 } from "lucide-react";
import { useState } from "react";
import { InlineInput } from "#/components/inline-edit.tsx";
import { type MenuEntry, MenuItems, MenuLabel } from "#/components/menu.tsx";
import { ContextMenuPopup, MenuRoot } from "#/components/ui/popup.tsx";
import { CUE_COLORS, type Cue, PAD_LETTERS, stamp } from "#/lib/cues.ts";
import { popup } from "#/lib/menu-styles.ts";
import type { ShortcutId } from "#/lib/shortcuts.ts";
import { keyHint, useShortcutLabel } from "#/lib/use-shortcuts.ts";
import { cn } from "#/lib/utils.ts";

/** The shortcut of pad `slot` (0 for A). */
const padShortcut = (slot: number) => `pad${Math.min(8, Math.max(1, slot + 1))}` as ShortcutId;

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
function Pad({
	slot,
	cue,
	actions,
	strip = false,
}: {
	slot: number;
	cue: Cue | undefined;
	actions: PadActions;
	/** One line, for the row under the deck's waveform. */
	strip?: boolean;
}) {
	const letter = PAD_LETTERS[slot] ?? "";
	const padKey = keyHint(useShortcutLabel(padShortcut(slot)));
	if (strip) {
		return cue ? (
			<SetPad slot={slot} cue={cue} actions={actions} strip />
		) : (
			<button
				type="button"
				onClick={() => actions.onSet(slot)}
				data-hint={`Set hot cue ${letter} at the playhead${padKey}`}
				className="group flex h-8 min-w-0 items-center gap-2 rounded-md border border-foreground/15 border-dashed px-2 text-left outline-none transition-colors hover:border-foreground/40 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60"
			>
				<span className="font-semibold text-muted-foreground text-xs">{letter}</span>
				<span className="truncate text-muted-foreground/0 text-xs transition-colors group-hover:text-muted-foreground">
					Set here
				</span>
			</button>
		);
	}
	if (!cue) {
		return (
			<button
				type="button"
				onClick={() => actions.onSet(slot)}
				data-hint={`Set hot cue ${letter} at the playhead${padKey}`}
				className="group flex h-16 flex-col justify-between rounded-md border border-foreground/15 border-dashed p-2 text-left outline-none transition-colors hover:border-foreground/40 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60"
			>
				<span className="font-semibold text-muted-foreground text-sm">{letter}</span>
				<span className="text-muted-foreground/0 text-xs transition-colors group-hover:text-muted-foreground">
					Set here
				</span>
			</button>
		);
	}
	return <SetPad slot={slot} cue={cue} actions={actions} />;
}

/** A pad with a cue on it: press to jump there; right-click to move, rename, colour or delete. */
function SetPad({
	slot,
	cue,
	actions,
	strip = false,
}: {
	slot: number;
	cue: Cue;
	actions: PadActions;
	strip?: boolean;
}) {
	const [renaming, setRenaming] = useState(false);
	const letter = PAD_LETTERS[slot] ?? "";
	const padKey = keyHint(useShortcutLabel(padShortcut(slot)));
	const color = cue.color || CUE_COLORS[0].hex;
	return (
		<MenuRoot>
			<MenuContextTrigger
				render={
					<div
						className={cn(
							"relative flex overflow-hidden rounded-md text-left",
							strip ? "h-8 min-w-0 items-center gap-2 px-2" : "h-16 flex-col justify-between p-2",
						)}
						style={{
							background: `color-mix(in oklch, ${color} 22%, var(--card))`,
							boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 60%, transparent)`,
						}}
					/>
				}
			>
				<span
					className={cn("absolute inset-x-0 top-0", strip ? "h-0.5" : "h-1")}
					style={{ background: color }}
				/>
				<button
					type="button"
					onClick={() => actions.onJump(cue.start)}
					data-hint={`Jump to hot cue ${letter}${padKey}`}
					className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
					aria-label={`Jump to hot cue ${letter}`}
				/>
				<span className="pointer-events-none relative flex items-baseline justify-between gap-2">
					<span className={cn("font-semibold", strip ? "text-xs" : "text-sm")} style={{ color }}>
						{letter}
					</span>
					{!strip && (
						<span className="text-[11px] text-muted-foreground tabular-nums">
							{stamp(cue.start)}
						</span>
					)}
				</span>
				{renaming ? (
					<span className="relative min-w-0 flex-1">
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
						{cue.name || (
							<span className="text-muted-foreground">
								{strip ? stamp(cue.start) : `Hot cue ${letter}`}
							</span>
						)}
					</span>
				)}
			</MenuContextTrigger>
			<ContextMenuPopup data-deck-popup className={popup} finalFocus="none">
				<MenuLabel>Hot cue {letter}</MenuLabel>
				<MenuItems items={padMenu(cue, slot, actions, () => setRenaming(true))} />
			</ContextMenuPopup>
		</MenuRoot>
	);
}

/** The eight hot cue pads in one row, under the deck's waveform. */
export function PadStrip({ cues, actions }: { cues: readonly Cue[]; actions: PadActions }) {
	return (
		<fieldset className="grid grid-cols-8 gap-1.5" aria-label="Hot cues">
			{PAD_LETTERS.map((_, slot) => (
				<Pad
					// biome-ignore lint/suspicious/noArrayIndexKey: pads are fixed places A–H
					key={slot}
					slot={slot}
					cue={cues.find((c) => c.slot === slot)}
					actions={actions}
					strip
				/>
			))}
		</fieldset>
	);
}
