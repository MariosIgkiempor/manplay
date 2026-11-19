import { ShieldAlert } from "lucide-react";
import type { Tone } from "#/components/diff-view.tsx";
import type { PushAction } from "#/lib/sync-choices.ts";

type Kind = PushAction["kind"];

export const LABEL: Record<Kind, { tone: Tone; label: string }> = {
	upload: { tone: "add", label: "Push" },
	replace: { tone: "change", label: "Change" },
	move: { tone: "move", label: "Move" },
	delete: { tone: "remove", label: "Delete" },
};
export const KINDS: Kind[] = ["upload", "replace", "move", "delete"];

/** The confirmation a push needs before it deletes files from a destination. */
export function DeleteGuard({
	removing,
	remoteFiles,
	understood,
	onChange,
}: {
	removing: number;
	remoteFiles: number;
	understood: boolean;
	onChange: (v: boolean) => void;
}) {
	if (removing === 0) {
		return null;
	}
	// Deleting most of a destination usually means the wrong folder or library was picked.
	const drastic = remoteFiles > 0 && removing / remoteFiles > 0.5;
	return (
		<div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
			{drastic && (
				<p className="flex items-start gap-2 font-medium text-destructive">
					<ShieldAlert className="mt-0.5 size-4 shrink-0" />
					Deletes over half the destination. Right folder?
				</p>
			)}
			<label className="flex cursor-pointer items-start gap-2">
				<input
					type="checkbox"
					className="mt-0.5 size-4 shrink-0 accent-primary"
					checked={understood}
					onChange={(e) => onChange(e.target.checked)}
				/>
				<span>
					Delete {removing.toLocaleString()} {removing === 1 ? "file" : "files"} (backed up first)
				</span>
			</label>
		</div>
	);
}
