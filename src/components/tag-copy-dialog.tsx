import { useEffect, useState } from "react";
import type { TagTarget } from "#/components/tag-editor.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useTagsRead } from "#/lib/queries.ts";
import type { TagClipboard } from "#/lib/tag-clipboard.ts";
import { TAG_GROUPS } from "#/lib/tag-fields.ts";

/** Pick which tags of a song or folder to copy. Tags that differ between its songs can't be copied. */
export function TagCopyDialog({
	target,
	onCopy,
	onClose,
}: {
	target: TagTarget;
	onCopy: (clip: TagClipboard) => void;
	onClose: () => void;
}) {
	const view = useTagsRead(target.path);
	const [picked, setPicked] = useState<Set<string> | null>(null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const fields = view.data?.fields ?? {};
	const rows = TAG_GROUPS.flatMap((g) => g.fields).filter(
		(f) => (target.isDir ? f.scope === "both" : true) && fields[f.id]?.value,
	);
	// Nothing is ticked until the user picks it.
	const chosen = picked ?? new Set<string>();
	const toggle = (id: string) => {
		const next = new Set(chosen);
		if (!next.delete(id)) {
			next.add(id);
		}
		setPicked(next);
	};
	const copy = () => {
		const values: Record<string, string> = {};
		for (const f of rows) {
			const v = fields[f.id]?.value;
			if (chosen.has(f.id) && v) {
				values[f.id] = v;
			}
		}
		onCopy({ from: target.name, values });
		onClose();
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div
				aria-hidden="true"
				onMouseDown={onClose}
				className="absolute inset-0 bg-background/60 backdrop-blur-sm"
			/>
			<div
				role="dialog"
				aria-label="Copy tags"
				className="relative flex max-h-[80vh] w-[28rem] max-w-[calc(100%-2rem)] flex-col rounded-xl border bg-background shadow-2xl"
			>
				<div className="border-b px-4 py-3">
					<div className="font-medium text-sm">Copy tags</div>
					<div className="truncate text-muted-foreground text-xs">From {target.name}</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
					{view.isPending && <p className="py-2 text-muted-foreground text-sm">Reading tags…</p>}
					{view.isSuccess && rows.length === 0 && (
						<p className="py-2 text-muted-foreground text-sm">
							Nothing to copy: no tags are set, or they differ between the songs.
						</p>
					)}
					{rows.map((f) => (
						<label key={f.id} className="flex cursor-pointer items-center gap-3 py-1.5 text-sm">
							<input
								type="checkbox"
								checked={chosen.has(f.id)}
								onChange={() => toggle(f.id)}
								className="size-4 accent-primary"
							/>
							<span className="w-28 shrink-0 text-muted-foreground">{f.label}</span>
							<span className="min-w-0 flex-1 truncate" title={fields[f.id]?.value ?? ""}>
								{fields[f.id]?.value}
							</span>
						</label>
					))}
				</div>
				<div className="flex items-center justify-between gap-2 border-t px-4 py-3">
					<span className="text-muted-foreground text-xs">
						{target.isDir ? "Folder: song-only tags are left out." : `${chosen.size} selected`}
					</span>
					<div className="flex gap-2">
						<Button variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button onClick={copy} disabled={chosen.size === 0}>
							Copy
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
