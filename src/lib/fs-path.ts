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

/** The last part of a path: `C:\Music\a.mp3` or `/Music/a.mp3` → `a.mp3`. */
export function baseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Whether `path` is strictly inside the folder `dir`. */
export function isInside(path: string, dir: string): boolean {
	const base = dir.replace(/[\\/]+$/, "");
	return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
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
