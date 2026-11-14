import { parentPath } from "#/lib/fs-path.ts";

interface Target {
	path: string;
	name: string;
	isDir: boolean;
}

/** `Song.mp3` → `Song`. A leading dot (hidden file) is not an extension. */
export function stripExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

function lastSegment(path: string): string {
	return (
		path
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() ?? ""
	);
}

/**
 * What a field can be filled with from the file or folder name: a song's title from its file
 * name, an album from the song's folder (or the folder itself when a folder is selected).
 */
export function fillFromPath(
	fieldId: string,
	target: Target,
): { value: string; from: string } | null {
	let fill: { value: string; from: string } | null = null;
	if (fieldId === "title" && !target.isDir) {
		fill = { value: stripExtension(target.name), from: "file name" };
	} else if (fieldId === "album") {
		fill = target.isDir
			? { value: target.name, from: "folder name" }
			: { value: lastSegment(parentPath(target.path)), from: "folder name" };
	}
	return fill && fill.value !== "" ? fill : null;
}
