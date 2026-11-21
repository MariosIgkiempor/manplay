import { describe, expect, it } from "vitest";
import type { UsbExportReport, UsbOutputs } from "#/lib/api.ts";
import {
	chosenOutputs,
	exportSteps,
	outputProblems,
	outputResults,
	reviewNotes,
} from "#/lib/usb-outputs.ts";

const none: UsbOutputs = {
	rekordbox: false,
	serato: false,
	gemini: false,
	playlistFolders: false,
};
const rekordbox: UsbOutputs = { ...none, rekordbox: true };

const report: UsbExportReport = {
	copied: 0,
	alreadyThere: 0,
	bytesCopied: 0,
	analyzed: 0,
	regridded: 0,
	playlists: 1,
	playlistsRemoved: 0,
	songsDeleted: 0,
	bytesFreed: 0,
	libraryTracks: 2,
	backup: null,
	rekordbox: false,
	oneLibrary: false,
	oneLibraryError: null,
	seratoCrates: null,
	seratoCratesRemoved: 0,
	seratoError: null,
	gemini: null,
	geminiError: null,
	playlistFolders: null,
	playlistFoldersError: null,
	failed: [],
};

describe("exportSteps", () => {
	it.each<[string, UsbOutputs, string[]]>([
		["rekordbox only", rekordbox, ["copying", "analyzing", "writing"]],
		["Serato only", { ...none, serato: true }, ["copying", "writing", "libraries"]],
		["Gemini only", { ...none, gemini: true }, ["copying", "analyzing", "writing", "libraries"]],
		["folders only", { ...none, playlistFolders: true }, ["copying", "writing", "folders"]],
		[
			"everything",
			{ rekordbox: true, serato: true, gemini: true, playlistFolders: true },
			["copying", "analyzing", "writing", "folders", "libraries"],
		],
	])("lists the phases for %s", (_name, outputs, phases) => {
		expect(exportSteps(outputs).map(([phase]) => phase)).toEqual(phases);
	});

	it("names what each writing step writes", () => {
		const labels = (outputs: UsbOutputs) => exportSteps(outputs).map(([, label]) => label);
		expect(labels({ ...rekordbox, serato: true, gemini: true })).toEqual([
			"Copy songs",
			"Beat grids and waveforms",
			"Write the rekordbox library",
			"Write Serato crates and the Gemini library",
		]);
		expect(labels({ ...none, serato: true })).toContain("Save the drive's song list");
	});
});

describe("reviewNotes", () => {
	it("says what each format on will do, and what switching rekordbox off does", () => {
		expect(reviewNotes(rekordbox, "add")).toHaveLength(1);
		const withoutRekordbox = reviewNotes({ ...none, serato: true }, "replacePlaylists");
		expect(withoutRekordbox).toHaveLength(2);
		expect(withoutRekordbox[0]).toContain("No rekordbox library is written");
		expect(withoutRekordbox[1]).toContain("removed playlists' crates go too");
	});
});

describe("chosenOutputs", () => {
	it("names what is switched on", () => {
		expect(chosenOutputs(none)).toEqual([]);
		expect(chosenOutputs({ ...none, gemini: true, playlistFolders: true })).toEqual([
			"Gemini",
			"Playlist folders",
		]);
	});
});

describe("outputResults and outputProblems", () => {
	it("say nothing when only the songs were written", () => {
		expect(outputResults(report)).toEqual([]);
		expect(outputProblems(report)).toEqual([]);
	});

	it("say which players read the rekordbox library", () => {
		expect(outputResults({ ...report, rekordbox: true, oneLibrary: true })).toEqual([
			{ label: "rekordbox", text: "Every Pioneer and AlphaTheta player" },
		]);
		const older = { ...report, rekordbox: true, oneLibraryError: "locked" };
		expect(outputResults(older)).toEqual([{ label: "rekordbox", text: "CDJ-3000 and older only" }]);
		expect(outputProblems(older)[0]).toContain("locked");
	});

	it("give a line for each extra written", () => {
		const lines = outputResults({
			...report,
			seratoCrates: 2,
			gemini: {
				tracks: 2,
				playlists: 1,
				playlistsLeftOut: 0,
				waveforms: 2,
				covers: 0,
				unplayable: 0,
				longPaths: 0,
				backup: null,
			},
			playlistFolders: {
				songs: 3,
				copies: 1,
				bytesCopied: 0,
				moved: 2,
				tooLong: 0,
				inTheWay: 0,
			},
		});
		expect(lines).toEqual([
			{ label: "Serato", text: "2 crates" },
			{ label: "Gemini", text: "2 songs, 1 playlist, 2 waveforms" },
			{ label: "Folders", text: "3 songs in Playlists, 1 copy for songs in several playlists" },
		]);
	});

	it("report errors and what a player will not show", () => {
		const problems = outputProblems({
			...report,
			geminiError: "disk full",
			gemini: {
				tracks: 2,
				playlists: 100,
				playlistsLeftOut: 3,
				waveforms: 2,
				covers: 0,
				unplayable: 1,
				longPaths: 2,
				backup: null,
			},
			playlistFolders: {
				songs: 0,
				copies: 0,
				bytesCopied: 0,
				moved: 0,
				tooLong: 1,
				inTheWay: 1,
			},
		});
		expect(problems).toHaveLength(5);
		expect(problems[0]).toContain("disk full");
		expect(problems[3]).toContain("3 songs left out of a playlist");
	});
});
