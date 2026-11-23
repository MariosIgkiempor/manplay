import { describe, expect, it } from "vitest";
import { type Effect, type EffectTone, groupEffects } from "#/components/ui/explainer.tsx";

const effect = (tone: EffectTone, what: string): Effect => ({ tone, what });

describe("groupEffects", () => {
	it.each<[string, Effect[], [EffectTone, string[]][]]>([
		["nothing", [], []],
		["one tone", [effect("kept", "Backup")], [["kept", ["Backup"]]]],
		[
			"what changes before what stays, whatever the order written",
			[effect("kept", "Backup"), effect("lost", "Playlists"), effect("changed", "Song list")],
			[
				["changed", ["Song list"]],
				["lost", ["Playlists"]],
				["kept", ["Backup"]],
			],
		],
		[
			"items in a group keep the order written",
			[effect("lost", "Playlists"), effect("info", "Note"), effect("lost", "Sync records")],
			[
				["lost", ["Playlists", "Sync records"]],
				["info", ["Note"]],
			],
		],
	])("%s", (_, effects, expected) => {
		expect(
			groupEffects(effects).map((g) => [g.tone, g.effects.map((e) => e.what)] as const),
		).toEqual(expected);
	});
});
