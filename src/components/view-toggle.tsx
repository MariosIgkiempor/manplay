import { Disc3, FolderTree, ListMusic } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/utils.ts";

export type View = "albums" | "songs" | "files";

export function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
	const item = (v: View, label: string, icon: ReactNode) => (
		<button
			type="button"
			onClick={() => onChange(v)}
			className={cn(
				"flex items-center gap-1.5 rounded-md px-3 py-1 text-sm",
				view === v ? "bg-background shadow" : "text-muted-foreground",
			)}
		>
			{icon}
			{label}
		</button>
	);
	return (
		<div className="flex rounded-lg bg-muted p-0.5">
			{item("albums", "Albums", <Disc3 className="size-4" />)}
			{item("songs", "Songs", <ListMusic className="size-4" />)}
			{item("files", "Files", <FolderTree className="size-4" />)}
		</div>
	);
}
