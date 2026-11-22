import type { Brand } from "#/components/brand-icon.tsx";

/** The folder's own name, the last part of its path. */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A mark for a folder: iTunes' for an iTunes or Music media folder, Downloads' for Downloads. */
export function folderBrand(path: string): Brand {
	if (/[\\/](itunes|music)[\\/](itunes media|music media|media|music)$/i.test(path)) {
		return "itunes";
	}
	return /[\\/]downloads$/i.test(path) ? "downloads" : "folder";
}
