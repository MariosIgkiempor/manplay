import { describe, expect, it } from "vitest";
import type { ImportGroup, ImportTrack } from "#/lib/api.ts";
import { bpmLabel, groupFacts, keyLabel, qualityOf } from "#/lib/import-meta.ts";

const track = (file: string, extra: Partial<ImportTrack> = {}): ImportTrack => ({
	src: { path: `/d/${file}`, entry: null },
	file,
	title: file,
	artist: "",
	size: 1,
	status: "new",
	hasArt: false,
	...extra,
});

describe("qualityOf", () => {
	it("flags thin lossy files and names lossless ones by sample rate", () => {
		expect(qualityOf(track("a.mp3", { bitrate: 128 }))).toEqual({ label: "MP3 128", low: true });
		expect(qualityOf(track("a.mp3", { bitrate: 320 }))).toEqual({ label: "MP3 320", low: false });
		expect(qualityOf(track("a.flac", { sampleRate: 44100 })).label).toBe("FLAC 44.1 kHz");
	});
});

describe("labels", () => {
	it("reads keys as Camelot and rounds BPM", () => {
		expect(keyLabel("Am")).toBe("8A");
		expect(keyLabel("weird")).toBe("weird");
		expect(bpmLabel("139.8")).toBe("140");
		expect(bpmLabel("")).toBeNull();
	});
});

describe("groupFacts", () => {
	it("takes the common year and calls differing qualities mixed", () => {
		const g = {
			tracks: [
				track("1.mp3", { year: "2021", bitrate: 320, durationMs: 60_000 }),
				track("2.mp3", { year: "2021", bitrate: 192, durationMs: 30_000 }),
			],
		} as ImportGroup;
		const f = groupFacts(g);
		expect(f.year).toBe("2021");
		expect(f.seconds).toBe(90);
		expect(f.quality).toEqual({ label: "Mixed quality", low: true });
	});
});

describe("trashTargets", () => {
	const g = (id: number, extra: Partial<ImportGroup>, files: string[]): ImportGroup => ({
		id,
		kind: "album",
		origin: "",
		fromZip: false,
		modified: 0,
		artist: "",
		album: "",
		images: [],
		tracks: files.map((f) => track(f, { src: { path: f, entry: extra.fromZip ? f : null } })),
		...extra,
	});
	it("takes a whole folder, single files, and a zip only when all of it is picked", async () => {
		const { trashTargets } = await import("#/lib/import-state.ts");
		const scan = {
			alreadyInLibrary: 0,
			errors: 0,
			groups: [
				g(1, {}, ["/d/A/1.mp3", "/d/A/2.mp3"]),
				g(2, { kind: "single" }, ["/d/loose.mp3"]),
				g(3, { fromZip: true }, ["/d/z.zip", "/d/z.zip"]),
			],
		};
		const zipped = scan.groups[2]?.tracks[1];
		if (zipped) {
			zipped.src = { path: "/d/z.zip", entry: "b.mp3" };
		}
		const keys = new Set([
			"/d/A/1.mp3\u0000",
			"/d/A/2.mp3\u0000",
			"/d/loose.mp3\u0000",
			"/d/z.zip\u0000/d/z.zip",
		]);
		expect(trashTargets(scan, keys, "/d")).toEqual({ paths: ["/d/A", "/d/loose.mp3"], kept: 1 });
	});
});
