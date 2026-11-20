import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn(), save: vi.fn() }));

const { checkJellyfinSongs, jellyfinPlan, jellyfinSettings, probeJellyfin, saveJellyfin } =
	await import("#/lib/api.ts");

const settings = {
	url: "http://nas:8096",
	serverName: "nas",
	user: { id: "5d3a9c1e", name: "mario" },
	library: { id: "7e64e319", name: "Music" },
	visibility: { kind: "users", users: ["aa11"] },
};

const server = {
	name: "nas",
	version: "12.4.0",
	users: [{ id: "5d3a9c1e", name: "mario" }],
	libraries: [{ id: "7e64e319", name: "Music", locations: ["/Volumes/KINGSTON/media/music"] }],
};

beforeEach(() => invoke.mockReset());

describe("jellyfinSettings", () => {
	it.each([
		["saved settings", settings],
		["nothing saved", null],
	])("accepts %s", async (_, reply) => {
		invoke.mockResolvedValueOnce(reply);
		await expect(jellyfinSettings(1)).resolves.toEqual(reply);
	});

	it.each([
		["an empty address", { ...settings, url: "" }],
		["an empty user id", { ...settings, user: { id: "", name: "mario" } }],
		["a missing library", { ...settings, library: undefined }],
		["a numeric library id", { ...settings, library: { id: 7, name: "Music" } }],
		["an unknown visibility", { ...settings, visibility: { kind: "public" } }],
		["users without a list", { ...settings, visibility: { kind: "users" } }],
		["an empty user in the list", { ...settings, visibility: { kind: "users", users: [""] } }],
		["no visibility", { ...settings, visibility: undefined }],
	])("rejects %s", async (_, reply) => {
		invoke.mockResolvedValueOnce(reply);
		await expect(jellyfinSettings(1)).rejects.toThrow();
	});
});

describe("probeJellyfin", () => {
	it("sends no key as null, so the saved one is used", async () => {
		invoke.mockResolvedValueOnce(server);
		await expect(probeJellyfin({ targetId: 3, url: "nas:8096" })).resolves.toEqual(server);
		expect(invoke).toHaveBeenCalledWith("jellyfin_probe", {
			targetId: 3,
			url: "nas:8096",
			apiKey: null,
		});
	});

	it.each([
		["libraries without locations", { ...server, libraries: [{ id: "a", name: "Music" }] }],
		["users without names", { ...server, users: [{ id: "a" }] }],
		["no version", { ...server, version: undefined }],
	])("rejects %s", async (_, reply) => {
		invoke.mockResolvedValueOnce(reply);
		await expect(probeJellyfin({ targetId: 3, url: "nas" })).rejects.toThrow();
	});
});

describe("saveJellyfin", () => {
	it("sends the choices and parses what was saved", async () => {
		invoke.mockResolvedValueOnce(settings);
		const saved = await saveJellyfin({
			targetId: 3,
			url: "nas:8096",
			apiKey: "key",
			userId: settings.user.id as never,
			libraryId: settings.library.id as never,
			visibility: { kind: "everyone" },
		});
		expect(saved).toEqual(settings);
		expect(invoke).toHaveBeenCalledWith("jellyfin_save", {
			targetId: 3,
			url: "nas:8096",
			apiKey: "key",
			userId: "5d3a9c1e",
			libraryId: "7e64e319",
			visibility: { kind: "everyone" },
		});
	});
});

describe("checkJellyfinSongs", () => {
	const check = { synced: 3, found: 2, missing: 1, ambiguous: 0, examples: ["A/B/01.mp3"] };

	it("accepts a check", async () => {
		invoke.mockResolvedValueOnce(check);
		await expect(checkJellyfinSongs(3)).resolves.toEqual(check);
	});

	it.each([
		["a negative count", { ...check, missing: -1 }],
		["a fractional count", { ...check, found: 1.5 }],
		["no examples", { ...check, examples: undefined }],
	])("rejects %s", async (_, reply) => {
		invoke.mockResolvedValueOnce(reply);
		await expect(checkJellyfinSongs(3)).rejects.toThrow();
	});
});

describe("jellyfinPlan", () => {
	const row = {
		key: "playlist:u1",
		name: "House",
		action: "update",
		oldName: null,
		adopted: false,
		songs: 2,
		added: 1,
		removed: 1,
		leftOut: 0,
	};

	it("accepts a review", async () => {
		invoke.mockResolvedValueOnce([row]);
		await expect(jellyfinPlan(1)).resolves.toEqual([row]);
	});

	it.each([
		["an unknown action", { ...row, action: "merge" }],
		["no old name field", { ...row, oldName: undefined }],
		["an empty key", { ...row, key: "" }],
		["a negative count", { ...row, leftOut: -1 }],
	])("rejects %s", async (_, reply) => {
		invoke.mockResolvedValueOnce([reply]);
		await expect(jellyfinPlan(1)).rejects.toThrow();
	});
});
