import { ClipboardCopy, FolderOpen } from "lucide-react";
import type { MenuEntry } from "#/components/menu.tsx";
import { fsReveal } from "#/lib/api.ts";
import { FILE_MANAGER } from "#/lib/platform.ts";

/**
 * Right-click rows for a file named by its path: find it in the file manager (only while it is
 * on disk), and copy the path to paste elsewhere.
 */
export function fileMenuEntries(
	path: string,
	{ onDisk = true }: { onDisk?: boolean } = {},
): MenuEntry[] {
	return [
		onDisk && {
			label: `Show in ${FILE_MANAGER}`,
			icon: <FolderOpen />,
			onSelect: () => void fsReveal(path),
		},
		{
			label: "Copy path",
			icon: <ClipboardCopy />,
			onSelect: () => void navigator.clipboard.writeText(path),
		},
	];
}
