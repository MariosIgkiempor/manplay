import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { BrandGlyph } from "#/components/brand-icon.tsx";
import { FolderFileNamesEditor, Highlighted } from "#/components/folder-file-names-editor.tsx";
import { WellCard } from "#/components/frame.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import type { FolderFileNames, RekordboxFormats, UsbOutputs } from "#/lib/api.ts";
import { formatFolderFileName } from "#/lib/folder-file-names.ts";
import {
	REKORDBOX_FORMATS,
	rekordboxFormatsName,
	USB_OUTPUTS,
	type UsbOutput,
	type UsbOutputOption,
} from "#/lib/usb-outputs.ts";
import { cn } from "#/lib/utils.ts";

/** A format's further choices: what they are called, their current value, and the controls. */
interface Extra {
	label: string;
	summary: ReactNode;
	controls: ReactNode;
}

/**
 * The formats the export writes, as a list of settings: each with its switch and what it is for,
 * and, when it has further choices, a summary of them that opens to change them. Remembered for
 * the drive with the export.
 */
export function UsbOutputsSettings({
	outputs,
	onChange,
	fileNames,
	onFileNames,
}: {
	outputs: UsbOutputs;
	onChange: (outputs: UsbOutputs) => void;
	fileNames: FolderFileNames;
	onFileNames: (parts: FolderFileNames) => void;
}) {
	const extras: Partial<Record<UsbOutput, Extra>> = {
		rekordbox: {
			label: "Libraries",
			summary: rekordboxFormatsName(outputs.rekordboxFormats),
			controls: (
				<RekordboxFormatsChoice
					formats={outputs.rekordboxFormats}
					onChange={(rekordboxFormats) => onChange({ ...outputs, rekordboxFormats })}
				/>
			),
		},
		playlistFolders: {
			label: "File names",
			summary: <Highlighted text={formatFolderFileName(fileNames)} />,
			controls: <FolderFileNamesEditor parts={fileNames} onChange={onFileNames} />,
		},
	};
	return (
		<section aria-label="Formats" className="space-y-1.5">
			<h3 className="px-1 font-medium text-muted-foreground text-xs">Formats</h3>
			<WellCard rows>
				{USB_OUTPUTS.map((option) => (
					<OutputRow
						key={option.key}
						option={option}
						on={outputs[option.key]}
						onSwitch={(on) => onChange({ ...outputs, [option.key]: on })}
						extra={extras[option.key]}
					/>
				))}
			</WellCard>
		</section>
	);
}

function OutputRow({
	option,
	on,
	onSwitch,
	extra,
}: {
	option: UsbOutputOption;
	on: boolean;
	onSwitch: (on: boolean) => void;
	extra: Extra | undefined;
}) {
	const [open, setOpen] = useState(false);
	const switchId = useId();
	const panelId = useId();
	const showExtra = on && extra !== undefined;
	return (
		<div className="px-3 py-2.5">
			<div className="flex items-start gap-3">
				<span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
					{option.brand ? (
						<BrandGlyph brand={option.brand} className="size-6" />
					) : (
						<option.icon className="size-5" />
					)}
				</span>
				<div className="min-w-0 flex-1">
					<label htmlFor={switchId} className="block font-medium text-sm">
						{option.title}
					</label>
					<p className="mt-0.5 text-pretty text-muted-foreground text-xs leading-relaxed">
						{option.detail}
					</p>
				</div>
				<Switch id={switchId} label={option.title} checked={on} onChange={onSwitch} />
			</div>
			{showExtra && (
				<div
					className={cn(
						"mt-2.5 ml-9 overflow-hidden rounded-lg border bg-muted/40",
						open && "bg-muted/60",
					)}
				>
					<button
						type="button"
						aria-expanded={open}
						aria-controls={panelId}
						onClick={() => setOpen(!open)}
						className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
					>
						<span className="shrink-0 text-muted-foreground">{extra.label}</span>
						{/* Open, the controls show the value; the summary would only repeat it. */}
						<span className="min-w-0 flex-1 truncate text-right text-foreground">
							{open ? null : extra.summary}
						</span>
						<ChevronDown
							className={cn(
								"size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
								open && "rotate-180",
							)}
						/>
					</button>
					{open && (
						<div id={panelId} className="fold-in border-t px-3 py-3">
							{extra.controls}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

type RekordboxChoice = "both" | keyof RekordboxFormats;

const REKORDBOX_CHOICES: readonly { value: RekordboxChoice; label: string }[] = [
	{ value: "both", label: "Both" },
	...REKORDBOX_FORMATS.map((f) => ({ value: f.key, label: f.title })),
];

function choiceOf(formats: RekordboxFormats): RekordboxChoice {
	if (formats.deviceLibrary && formats.oneLibrary) {
		return "both";
	}
	return formats.deviceLibrary ? "deviceLibrary" : "oneLibrary";
}

function formatsOf(choice: RekordboxChoice): RekordboxFormats {
	return {
		deviceLibrary: choice !== "oneLibrary",
		oneLibrary: choice !== "deviceLibrary",
	};
}

/** Which of rekordbox's libraries to write, as one choice of three, and who can read it. */
function RekordboxFormatsChoice({
	formats,
	onChange,
}: {
	formats: RekordboxFormats;
	onChange: (formats: RekordboxFormats) => void;
}) {
	const name = useId();
	const choice = choiceOf(formats);
	const left = REKORDBOX_FORMATS.find((f) => !formats[f.key]);
	return (
		<fieldset className="space-y-2.5">
			<legend className="sr-only">rekordbox libraries to write</legend>
			<div className="flex rounded-lg bg-muted p-0.5">
				{REKORDBOX_CHOICES.map((c) => (
					<label
						key={c.value}
						className={cn(
							"flex flex-1 cursor-pointer items-center justify-center rounded-md px-2 py-1 text-xs transition-colors",
							"has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/60",
							choice === c.value
								? "bg-background font-medium text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<input
							type="radio"
							name={name}
							value={c.value}
							checked={choice === c.value}
							onChange={() => onChange(formatsOf(c.value))}
							className="sr-only"
						/>
						{c.label}
					</label>
				))}
			</div>
			<ul className="space-y-1 text-xs">
				{REKORDBOX_FORMATS.map((f) => (
					<li
						key={f.key}
						className={cn(
							"flex items-baseline gap-2",
							formats[f.key] ? "text-foreground" : "text-muted-foreground line-through",
						)}
					>
						<span className="w-24 shrink-0 font-medium">{f.title}</span>
						<span className={cn(formats[f.key] && "text-muted-foreground")}>{f.players}</span>
					</li>
				))}
			</ul>
			{left && (
				<p className="text-muted-foreground text-xs">
					A {left.title} already on the drive is removed, with a copy kept.
				</p>
			)}
		</fieldset>
	);
}
