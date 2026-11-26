import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportFolderId } from "#/lib/api.ts";
import { createFakeBackend, type FakeBackend, SCENARIOS } from "./fake-backend.ts";
import { DOWNLOADS_FOLDER, NAS_TARGET_ID, USB_MOUNT } from "./fake-places.ts";

/** The fake backend only helps while the app accepts what it answers: every answer below goes
 * through the same zod schemas in `api.ts` that check the real backend's. */

let backend: FakeBackend = createFakeBackend("full");
const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
	const answer = backend.run(command, args ?? {});
	return answer.handled
		? Promise.resolve(answer.result)
		: Promise.reject(new Error(`no fake for ${command}`));
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const api = await import("#/lib/api.ts");

const FOLDER_ID = 1 as ImportFolderId;
const ADD_OPTIONS = { convertAac: false, autoImport: false };

const NO_RULES = {
	allTags: [],
	anyTags: [],
	noneTags: [],
	added: null,
	bpmMin: null,
	bpmMax: null,
};

const READS: [name: string, read: () => Promise<unknown>][] = [
	["listTracks", () => api.listTracks()],
	["analysisSettings", () => api.analysisSettings()],
	["analysisFailures", () => api.analysisFailures()],
	["getLibraryRoot", () => api.getLibraryRoot()],
	["libraryStatus", () => api.libraryStatus()],
	["listMissing", () => api.listMissing()],
	["listDuplicates", () => api.listDuplicates()],
	["listCarryCandidates", () => api.listCarryCandidates()],
	["listPlaylists", () => api.listPlaylists()],
	["playlistTracks", () => api.playlistTracks(1)],
	["listTags", () => api.listTags()],
	["getDefaultScope", () => api.getDefaultScope()],
	["tailscaleStatus", () => api.tailscaleStatus()],
	["driveList", () => api.driveList("tail1234.ts.net", "studio-nas", [])],
	["listSyncTargets", () => api.listSyncTargets()],
	["libsyncInspect", () => api.libsyncInspect(NAS_TARGET_ID)],
	["getDeviceName", () => api.getDeviceName()],
	["jellyfinSettings", () => api.jellyfinSettings(NAS_TARGET_ID)],
	["probeJellyfin", () => api.probeJellyfin({ targetId: NAS_TARGET_ID, url: "http://nas" })],
	["checkJellyfinSongs", () => api.checkJellyfinSongs(NAS_TARGET_ID)],
	["jellyfinDestinations", () => api.jellyfinDestinations()],
	["jellyfinPlan", () => api.jellyfinPlan(NAS_TARGET_ID)],
	["jellyfinServerPlaylists", () => api.jellyfinServerPlaylists(NAS_TARGET_ID)],
	["syncHistory", () => api.syncHistory(50)],
	["activityHistory", () => api.activityHistory("import:1", 50)],
	["syncScans", () => api.syncScans()],
	["syncScan", () => api.syncScan(NAS_TARGET_ID)],
	["serviceFlags", () => api.serviceFlags()],
	["rekordboxStatus", () => api.rekordboxStatus()],
	["rekordboxLibrary", () => api.rekordboxLibrary()],
	["rekordboxSelection", () => api.rekordboxSelection()],
	["smartPlaylists", () => api.smartPlaylists()],
	["smartPlaylistPreview", () => api.smartPlaylistPreview(NO_RULES)],
	["smartLocalTags", () => api.smartLocalTags(NO_RULES)],
	["sharePreview", () => api.sharePreview("playlist", 1)],
	["privatePreview", () => api.privatePreview("playlist", 1)],
	["listClashes", () => api.listClashes()],
	["clashCombinePreview", () => api.clashCombinePreview(1)],
	["listRecentlyDeleted", () => api.listRecentlyDeleted()],
	["libsyncStatus", () => api.libsyncStatus()],
	["listLibraryChanges", () => api.listLibraryChanges()],
	["listFileRemovals", () => api.listFileRemovals()],
	["keepFileRemovals", () => api.keepFileRemovals(["removed-1"])],
	["applyFileRemovals", () => api.applyFileRemovals(["removed-2"])],
	["undoLibraryChanges", () => api.undoLibraryChanges(1)],
	["fsList", () => api.fsList("/Users/dj/Music/Library")],
	["fsDirSizes", () => api.fsDirSizes("/Users/dj/Music/Library")],
	["clipboardReadText", () => api.clipboardReadText()],
	["pickerPlaces", () => api.pickerPlaces()],
	["pickerList", () => api.pickerList("/Users/dj/Pictures")],
	["pickerList in the library", () => api.pickerList("/Users/dj/Music/Library")],
	["pickerMakeDir", () => api.pickerMakeDir("/Users/dj/Music", "New set")],
	["pickerReadImage", () => api.pickerReadImage("/Users/dj/Pictures/Homework.jpg")],
	["remoteList", () => api.remoteList(NAS_TARGET_ID, [])],
	["remoteDirSizes", () => api.remoteDirSizes(NAS_TARGET_ID, [])],
	["auditLibrary", () => api.auditLibrary()],
	["tagsRead", () => api.tagsRead("/Users/dj/Music/Library")],
	["tagValues", () => api.tagValues("genre")],
	["tagsPreview", () => api.tagsPreview("/Users/dj/Music/Library", {})],
	["getLibraryView", () => api.getLibraryView()],
	["getPanelTabs", () => api.getPanelTabs()],
	["getUiSetting", () => api.getUiSetting("sort")],
	["getTagClipboard", () => api.getTagClipboard()],
	["importFolders", () => api.importFolders()],
	["importAddFolder", () => api.importAddFolder(DOWNLOADS_FOLDER, ADD_OPTIONS)],
	["importScan", () => api.importScan(FOLDER_ID)],
	["importCached", () => api.importCached(FOLDER_ID)],
	["usbDrives", () => api.usbDrives()],
	["usbLibrary", () => api.usbLibrary(USB_MOUNT)],
	["usbFormats", () => api.usbFormats(USB_MOUNT)],
	["usbBackups", () => api.usbBackups(USB_MOUNT)],
	["usbExportSelection", () => api.usbExportSelection("usb-7C2A-11F0")],
	["usbExportPreview", () => api.usbExportPreview(USB_MOUNT, DEFAULT_SELECTION)],
	["exportToUsb", () => api.exportToUsb(USB_MOUNT, DEFAULT_SELECTION)],
	["trackAnalysis", () => api.trackAnalysis(1)],
	["trackCues", () => api.trackCues(1)],
];

const DEFAULT_SELECTION = await api.rekordboxSelection();

describe.each(SCENARIOS)("the %s scenario", (scenario) => {
	beforeEach(() => {
		backend = createFakeBackend(scenario);
	});

	it.each(READS)("answers %s in the shape the app accepts", async (_name, read) => {
		await expect(read()).resolves.toBeDefined();
	});
});

describe("commands", () => {
	const source = readFileSync(new URL("../lib/api.ts", import.meta.url), "utf8");
	const called = [
		...new Set([...source.matchAll(/invoke(?:<[^>]+>)?\(\s*"([^"]+)"/g)].map((m) => m[1])),
	];

	it("finds the commands api.ts calls", () => {
		expect(called.length).toBeGreaterThan(100);
	});

	it.each(called)("has an answer for %s", (command) => {
		expect(createFakeBackend("full").knows(command ?? "")).toBe(true);
	});
});

describe("edits", () => {
	beforeEach(() => {
		backend = createFakeBackend("full");
	});

	it("shows a new playlist and the songs added to it", async () => {
		const id = await api.createPlaylist("Test set");
		await api.addToPlaylist(id, [1, 2]);
		const created = (await api.listPlaylists()).find((playlist) => playlist.id === id);
		expect(created).toMatchObject({ name: "Test set", trackCount: 2 });
		expect((await api.playlistTracks(id)).map((track) => track.id)).toEqual([1, 2]);
	});

	it("counts a tag's songs as they are tagged and untagged", async () => {
		await api.tagTracks("Sets/Test", [1, 2, 3]);
		await api.untagTrack("Sets/Test", 2);
		const tag = (await api.listTags()).find((candidate) => candidate.name === "Sets/Test");
		expect(tag?.trackCount).toBe(2);
	});

	it("looks tags up only once the lookup service is switched on", async () => {
		const library = await api.getLibraryRoot();
		await expect(api.tagsLookup(library ?? "", false)).rejects.toThrow("Tag lookup is off");
		await api.setServiceEnabled("lookup", true);
		expect(await api.serviceFlags()).toMatchObject({ lookup: "on" });
		const songs = await api.tagsLookup(library ?? "", false);
		expect(new Set(songs.map((song) => song.outcome.kind))).toEqual(
			new Set(["matched", "noMatch"]),
		);
		const cover = songs.flatMap((song) =>
			song.outcome.kind === "matched" ? (song.outcome.candidates[0]?.cover ?? []) : [],
		)[0];
		expect(cover).toBeDefined();
		if (cover) {
			await expect(api.tagsLookupCover([library ?? ""], cover)).resolves.toBeDefined();
		}
		const found = await api.coverSearch(library ?? "", false);
		expect(found.options.length).toBeGreaterThan(0);
	});

	it("keeps a display setting", async () => {
		await api.setUiSetting("sort", { key: "bpm", desc: true });
		expect(await api.getUiSetting("sort")).toEqual({ key: "bpm", desc: true });
	});
});
