import { describe, expect, it } from "vitest";
import { albumOfSong } from "#/lib/albums.ts";

const song = (path: string, artist: string, album: string) => ({ path, artist, album });

describe("albumOfSong", () => {
	const library = [
		song("/m/A/1.mp3", "Kas", "Night"),
		song("/m/A/2.mp3", "Kas", "Night"),
		song("/m/B/1.mp3", "Kas", "Solo"),
		song("/m/C/1.mp3", "Other", "Night"),
		song("/m/D/1.mp3", "Kas", ""),
		song("/m/D/2.mp3", "Kas", ""),
	];
	it.each([
		["a song on an album of two", 0, ["/m/A/1.mp3", "/m/A/2.mp3"]],
		["the only song on its album", 2, undefined],
		["an album of the same name by someone else", 3, undefined],
		["a song with no album", 4, undefined],
	])("offers the album for %s", (_name, at, paths) => {
		const track = library[at] ?? song("", "", "");
		expect(albumOfSong(track, library)?.paths).toEqual(paths);
	});
});
