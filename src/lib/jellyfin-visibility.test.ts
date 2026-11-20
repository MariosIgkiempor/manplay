import { describe, expect, it } from "vitest";
import type { JellyfinUserId, JellyfinVisibility } from "#/lib/api.ts";
import { normaliseVisibility, sameVisibility, toggleViewer } from "#/lib/jellyfin-visibility.ts";

const id = (s: string) => s as JellyfinUserId;
const users = (...ids: string[]): JellyfinVisibility => ({ kind: "users", users: ids.map(id) });
const me = id("me");

describe("normaliseVisibility", () => {
	it.each<[string, JellyfinVisibility, JellyfinVisibility]>([
		["only me stays", { kind: "onlyMe" }, { kind: "onlyMe" }],
		["everyone stays", { kind: "everyone" }, { kind: "everyone" }],
		["sorts and dedupes", users("b", "a", "b"), users("a", "b")],
		["drops the owner", users("me", "a"), users("a")],
		["nobody left is only me", users("me"), { kind: "onlyMe" }],
		["an empty list is only me", users(), { kind: "onlyMe" }],
	])("%s", (_, given, expected) => {
		expect(normaliseVisibility(given, me)).toEqual(expected);
	});
});

describe("sameVisibility", () => {
	it.each<[string, JellyfinVisibility, JellyfinVisibility, boolean]>([
		["same users in another order", users("a", "b"), users("b", "a"), true],
		["owner ticked counts as nothing", users("me"), { kind: "onlyMe" }, true],
		["different users", users("a"), users("b"), false],
		["everyone vs only me", { kind: "everyone" }, { kind: "onlyMe" }, false],
	])("%s", (_, a, b, same) => {
		expect(sameVisibility(a, b, me)).toBe(same);
	});
});

describe("toggleViewer", () => {
	it.each<[string, JellyfinVisibility, string, JellyfinVisibility]>([
		["ticks from only me", { kind: "onlyMe" }, "a", users("a")],
		["ticks from everyone", { kind: "everyone" }, "a", users("a")],
		["adds to the list", users("a"), "b", users("a", "b")],
		["unticks", users("a", "b"), "a", users("b")],
	])("%s", (_, given, user, expected) => {
		expect(toggleViewer(given, id(user))).toEqual(expected);
	});
});
