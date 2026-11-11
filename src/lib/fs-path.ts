/** Path helpers for absolute paths handed out by the backend (`/` or `\` separated). */

function sepOf(path: string): string {
	return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

const AUDIO = new Set(["wav", "flac", "mp3", "aif", "aiff", "m4a"]);

export function isAudioName(name: string): boolean {
	return AUDIO.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase());
}

export function joinPath(base: string, ...parts: string[]): string {
	const sep = sepOf(base);
	return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

export function parentPath(path: string): string {
	const sep = sepOf(path);
	const i = path.replace(/[\\/]+$/, "").lastIndexOf(sep);
	return i <= 0 ? sep : path.slice(0, i);
}

/** Folder names from `root` down to `path`; empty when `path` is the root or outside it. */
export function relSegments(root: string, path: string): string[] {
	const base = root.replace(/[\\/]+$/, "");
	if (path === base || !path.startsWith(base)) {
		return [];
	}
	return path
		.slice(base.length)
		.split(/[\\/]/)
		.filter((s) => s !== "");
}
