import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POP_SPRING, springCurve, springDuration } from "#/lib/motion.ts";

/**
 * The app moves one way: everything rides the curves in `motion.ts` and the tokens in
 * `styles.css`. This reads the source and fails when a curve is written out anywhere else.
 */

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The only files that name a curve. */
const TOKEN_FILES = new Set(["lib/motion.ts", "styles.css"]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return sourceFiles(path);
		}
		return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

describe("one motion", () => {
	it("no file but the token files writes out a curve", () => {
		const strays = sourceFiles(SOURCE_ROOT)
			.map((path) => relative(SOURCE_ROOT, path))
			.filter((path) => !TOKEN_FILES.has(path))
			.filter((path) =>
				/cubic-bezier\(|linear\(\s*0/.test(readFileSync(join(SOURCE_ROOT, path), "utf8")),
			);
		expect(strays).toEqual([]);
	});

	it("the stylesheet's curves are written out only among its tokens", () => {
		const css = readFileSync(join(SOURCE_ROOT, "styles.css"), "utf8");
		const outside = css
			.split("\n")
			.filter((line) => /cubic-bezier\(/.test(line))
			.filter((line) => !/^\s*--[\w-]+:/.test(line));
		expect(outside).toEqual([]);
	});

	it("the stylesheet's spring is the one scripted animations use", () => {
		const css = readFileSync(join(SOURCE_ROOT, "styles.css"), "utf8");
		const points = (curve: string) => curve.split(",").map((point) => Number(point));
		const written = /--spring-pop: linear\(([^)]*)\)/.exec(css)?.[1] ?? "";
		const wanted = springCurve(POP_SPRING).slice("linear(".length, -1);
		expect(points(written)).toEqual(points(wanted));
		expect(css).toContain(`--spring-pop-ms: ${springDuration(POP_SPRING)}ms;`);
	});
});
