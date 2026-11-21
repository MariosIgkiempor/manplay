import { Disc3, FolderTree, Laptop, type LucideIcon, Radio, Usb } from "lucide-react";
import type {
	PlaylistFoldersSummary,
	UsbExportProgress,
	UsbExportReport,
	UsbMode,
	UsbOutputs,
} from "#/lib/api.ts";
import { plural } from "#/lib/export-selection.ts";
import { formatBytes } from "#/lib/format.ts";

export type UsbOutput = keyof UsbOutputs;

/** One format an export can write onto the drive, as every part of the drawer shows it. */
export interface UsbOutputOption {
	key: UsbOutput;
	icon: LucideIcon;
	/** Short name, for lists of what is switched on. */
	name: string;
	title: string;
	detail: string;
	/** What the review says the export will do, given what happens to the drive's other playlists. */
	reviewNote: (mode: UsbMode) => string;
	/** What the review says when it is switched off, if that changes the drive too. */
	offNote?: string;
}

export const USB_OUTPUTS: readonly UsbOutputOption[] = [
	{
		key: "rekordbox",
		icon: Usb,
		name: "rekordbox",
		title: "rekordbox library",
		detail: "For Pioneer and AlphaTheta players: CDJ, XDJ, Opus Quad and the rest, old and new.",
		reviewNote: () => "The drive's songs and playlists are written as a rekordbox library.",
		offNote:
			"No rekordbox library is written. One already on the drive is removed, with a copy kept in PIONEER/manplay-backup.",
	},
	{
		key: "serato",
		icon: Disc3,
		name: "Serato",
		title: "Serato crates",
		detail: "Serato DJ shows each playlist as a crate and analyses new songs itself.",
		reviewNote: (mode) =>
			`Each exported playlist is written as a Serato crate${
				mode === "add" ? "" : ", and removed playlists' crates go too"
			}.`,
	},
	{
		key: "virtualDj",
		icon: Laptop,
		name: "VirtualDJ",
		title: "VirtualDJ library",
		detail:
			"VirtualDJ shows each playlist as a list on the drive, with the cues set in manplay, and analyses new songs itself. Export again after moving the drive between a Mac and a PC.",
		reviewNote: (mode) =>
			`Each exported playlist is written as a VirtualDJ list${
				mode === "add" ? "" : ", and removed playlists' lists go too"
			}.`,
	},
	{
		key: "gemini",
		icon: Radio,
		name: "Gemini",
		title: "Gemini MDJ library",
		detail:
			"Cues, beat grids and waveforms for Gemini MDJ players, as V-CASE wrote them. Those players only load MP3 and WAV.",
		reviewNote: () => "The drive's songs and playlists are written as a Gemini library.",
	},
	{
		key: "playlistFolders",
		icon: FolderTree,
		name: "Playlist folders",
		title: "Playlists as folders",
		detail:
			"For players that only browse folders, like the MDJ-500. Songs move into their playlist's folder in Playlists; only a song in several playlists is stored again.",
		reviewNote: () =>
			"Songs move into a folder per playlist in Playlists. A song in several playlists is copied into each further one.",
	},
];

/** The short names of what is switched on, for a one-line summary. */
export function chosenOutputs(outputs: UsbOutputs): string[] {
	return USB_OUTPUTS.filter((o) => outputs[o.key]).map((o) => o.name);
}

/** What the review says about the formats: a note for each one on, and for one whose being off changes the drive. */
export function reviewNotes(outputs: UsbOutputs, mode: UsbMode): string[] {
	return USB_OUTPUTS.flatMap((o) => {
		if (outputs[o.key]) {
			return [o.reviewNote(mode)];
		}
		return o.offNote ? [o.offNote] : [];
	});
}

/** What an export does, in order, given the formats it was asked to write. */
export function exportSteps(outputs: UsbOutputs): [UsbExportProgress["phase"], string][] {
	const libraries = [
		outputs.serato && "Serato crates",
		outputs.virtualDj && "the VirtualDJ library",
		outputs.gemini && "the Gemini library",
	].filter((name): name is string => Boolean(name));
	const steps: [UsbExportProgress["phase"], string][] = [["copying", "Copy songs"]];
	// Only rekordbox's players and the Gemini library read beat grids from the drive.
	if (outputs.rekordbox || outputs.gemini) {
		steps.push(["analyzing", "Beat grids and waveforms"]);
	}
	steps.push([
		"writing",
		outputs.rekordbox ? "Write the rekordbox library" : "Save the drive's song list",
	]);
	if (outputs.playlistFolders) {
		steps.push(["folders", "Fill the playlist folders"]);
	}
	if (libraries.length > 0) {
		steps.push(["libraries", `Write ${listed(libraries)}`]);
	}
	return steps;
}

/** Names joined as a sentence lists them: `a`, `a and b`, `a, b and c`. */
function listed(names: string[]): string {
	return names.length < 3
		? names.join(" and ")
		: `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A line of the finished export's summary. */
export interface OutputResult {
	label: string;
	text: string;
}

function foldersLine(f: PlaylistFoldersSummary): string {
	if (f.copies === 0) {
		return `${plural(f.songs, "song")} in Playlists`;
	}
	const copied = f.bytesCopied > 0 ? ` (${formatBytes(f.bytesCopied)} copied)` : "";
	return `${plural(f.songs, "song")} in Playlists, ${plural(f.copies, "copy", "copies")} for songs in several playlists${copied}`;
}

/** What each format wrote, for the summary. */
export function outputResults(report: UsbExportReport): OutputResult[] {
	const out: OutputResult[] = [];
	if (report.rekordbox) {
		out.push({
			label: "rekordbox",
			text: report.oneLibrary ? "Every Pioneer and AlphaTheta player" : "CDJ-3000 and older only",
		});
	}
	if (report.seratoCrates !== null) {
		const removed =
			report.seratoCratesRemoved > 0
				? `, ${plural(report.seratoCratesRemoved, "crate")} removed`
				: "";
		out.push({ label: "Serato", text: `${plural(report.seratoCrates, "crate")}${removed}` });
	}
	if (report.virtualDjLists !== null) {
		const removed =
			report.virtualDjListsRemoved > 0
				? `, ${plural(report.virtualDjListsRemoved, "list")} removed`
				: "";
		out.push({ label: "VirtualDJ", text: `${plural(report.virtualDjLists, "list")}${removed}` });
	}
	if (report.gemini) {
		const g = report.gemini;
		out.push({
			label: "Gemini",
			text: `${plural(g.tracks, "song")}, ${plural(g.playlists, "playlist")}, ${plural(g.waveforms, "waveform")}`,
		});
	}
	if (report.playlistFolders) {
		out.push({ label: "Folders", text: foldersLine(report.playlistFolders) });
	}
	return out;
}

/** What a format had to leave out because of a limit of its players or of the drive. */
function leftOut(report: UsbExportReport): string[] {
	const g = report.gemini;
	const tooLong = (g?.longPaths ?? 0) + (report.playlistFolders?.tooLong ?? 0);
	const inTheWay = report.playlistFolders?.inTheWay ?? 0;
	const counted: [number, (n: number) => string][] = [
		[
			g?.unplayable ?? 0,
			(n) => `${plural(n, "song")} will not load on a Gemini player: it only plays MP3 and WAV.`,
		],
		[
			g?.playlistsLeftOut ?? 0,
			(n) => `${plural(n, "playlist")} left out of the Gemini library: a player lists 100 at most.`,
		],
		[
			tooLong,
			(n) =>
				`${plural(n, "song")} left out of a playlist: the file path is too long for the player.`,
		],
		[
			inTheWay,
			(n) =>
				`${plural(n, "song")} not copied into a playlist folder: another file with that name is there.`,
		],
	];
	return counted.filter(([n]) => n > 0).map(([n, say]) => say(n));
}

/** What went wrong or was left out in a format; the songs and the other formats were written. */
export function outputProblems(report: UsbExportReport): string[] {
	const out: string[] = [];
	if (report.oneLibraryError) {
		out.push(
			`The OneLibrary for the CDJ-3000X, Opus Quad, XDJ-AZ and Omnis Duo could not be written, so the old one was removed: ${report.oneLibraryError}`,
		);
	}
	if (report.seratoError) {
		out.push(`The Serato crates could not be written: ${report.seratoError}`);
	}
	if (report.virtualDjError) {
		out.push(`The VirtualDJ library could not be written: ${report.virtualDjError}`);
	}
	if (report.geminiError) {
		out.push(`The Gemini library could not be written: ${report.geminiError}`);
	}
	if (report.playlistFoldersError) {
		out.push(`The playlist folders could not be finished: ${report.playlistFoldersError}`);
	}
	return [...out, ...leftOut(report)];
}
