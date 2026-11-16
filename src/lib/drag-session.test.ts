import { describe, expect, it } from "vitest";
import {
	type DragItem,
	type DragSession,
	dropOp,
	LIBRARY,
	sameSource,
} from "#/lib/drag-session.ts";

const remote = (id: number) => ({ kind: "remote", id }) as const;
const item = (path: string, isDir = false): DragItem => ({
	path,
	name: path.split("/").pop() ?? "",
	isDir,
});
const session = (source: DragSession["source"], ...items: DragItem[]): DragSession => ({
	source,
	items,
});
const dest = (source: DragSession["source"], path: string) => ({ pane: 0 as const, source, path });

describe("dropOp", () => {
	it("moves inside the library", () => {
		expect(dropOp(session(LIBRARY, item("/m/a.mp3")), dest(LIBRARY, "/m/x"))).toBe("move");
	});

	it("refuses to drop a folder into itself or below itself", () => {
		const s = session(LIBRARY, item("/m/a", true));
		expect(dropOp(s, dest(LIBRARY, "/m/a"))).toBeNull();
		expect(dropOp(s, dest(LIBRARY, "/m/a/deep"))).toBeNull();
		expect(dropOp(s, dest(LIBRARY, "/m/ab"))).toBe("move");
	});

	it("refuses to drop where everything already is", () => {
		const s = session(LIBRARY, item("/m/a.mp3"), item("/m/b.mp3"));
		expect(dropOp(s, dest(LIBRARY, "/m"))).toBeNull();
		expect(
			dropOp(session(LIBRARY, item("/m/a.mp3"), item("/m/x/b.mp3")), dest(LIBRARY, "/m")),
		).toBe("move");
	});

	it("copies between the library and a destination, in either direction", () => {
		expect(dropOp(session(LIBRARY, item("/m/a.mp3")), dest(remote(1), "/"))).toBe("copy");
		expect(dropOp(session(remote(1), item("/a.mp3")), dest(LIBRARY, "/m"))).toBe("copy");
	});

	it("moves inside one destination and refuses to cross two", () => {
		expect(dropOp(session(remote(1), item("/a.mp3")), dest(remote(1), "/x"))).toBe("move");
		expect(dropOp(session(remote(1), item("/a.mp3")), dest(remote(1), "/"))).toBeNull();
		expect(dropOp(session(remote(1), item("/a.mp3")), dest(remote(2), "/x"))).toBeNull();
	});

	it("compares sources", () => {
		expect(sameSource(LIBRARY, LIBRARY)).toBe(true);
		expect(sameSource(remote(1), remote(1))).toBe(true);
		expect(sameSource(remote(1), remote(2))).toBe(false);
		expect(sameSource(LIBRARY, remote(1))).toBe(false);
	});
});
