/** What differs in wording between macOS and Windows. Shortcut handlers already accept both ⌘
 * and Ctrl; only the labels change. */

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isMac = /Macintosh|Mac OS X/.test(ua) || !/Windows/.test(ua);
export const isWindows = !isMac;

/** The system file manager. */
export const FILE_MANAGER = isMac ? "Finder" : "File Explorer";
/** Where deleted files go. */
export const TRASH = isMac ? "Trash" : "Recycle Bin";

/** A shortcut written with Mac symbols, for this platform: `⌘K` → `Ctrl+K`, `⌘⌫` → `Del`. */
export function keyLabel(keys: string, mac = isMac): string {
	if (mac) {
		return keys;
	}
	const names: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
	return (
		keys
			.replaceAll("⌘⌫", "Del")
			.replaceAll("↵", "Enter")
			.replaceAll("⌫", "Backspace")
			// A modifier on its own (“with ⌥”) is a word; one before a key joins it with “+”.
			.replace(/([⌘⌥⇧])(?=[\s)]|$)/gu, (m) => names[m] ?? m)
			.replace(/[⌘⌥⇧]/gu, (m) => `${names[m] ?? m}+`)
	);
}
