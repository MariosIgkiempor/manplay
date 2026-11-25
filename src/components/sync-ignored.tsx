import { Eye, File, Folder } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import type { Ignored, IgnoreRule } from "#/lib/api.ts";

const ruleKey = (r: IgnoreRule) => `${r.scope}:${r.rel.join("/")}`;

const hiding = (files: number) =>
	files === 0 ? "nothing there now" : `${files.toLocaleString()} ${files === 1 ? "file" : "files"}`;

/**
 * A destination's ignored songs and album folders, folded: each can be shown in the review again.
 * A rule stays listed while it hides nothing, so one whose files left the destination can still go.
 */
export function SyncIgnoredList({
	ignored,
	busy,
	onUnignore,
}: {
	ignored: readonly Ignored[];
	busy: boolean;
	onUnignore: (rules: IgnoreRule[]) => void;
}) {
	if (ignored.length === 0) {
		return null;
	}
	const rules = ignored.map(({ rel, scope }) => ({ rel, scope }));
	return (
		<details className="mx-[var(--diff-inset)] mb-3 rounded-md border px-3 py-2 text-xs">
			<summary className="cursor-pointer text-muted-foreground">
				{ignored.length.toLocaleString()} ignored: never copied here or deleted there
			</summary>
			<ul className="mt-2 space-y-1">
				{ignored.map((i) => (
					<li key={ruleKey(i)} className="flex min-w-0 items-center gap-2">
						{i.scope === "folder" ? (
							<Folder aria-label="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
						) : (
							<File aria-label="File" className="size-3.5 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 flex-1 break-all font-mono">{i.rel.join("/")}</span>
						<span className="shrink-0 text-muted-foreground tabular-nums">{hiding(i.files)}</span>
						<Button
							variant="ghost"
							size="xs"
							disabled={busy}
							onClick={() => onUnignore([{ rel: i.rel, scope: i.scope }])}
						>
							<Eye />
							Unignore
						</Button>
					</li>
				))}
			</ul>
			{ignored.length > 1 && (
				<Button
					variant="outline"
					size="xs"
					className="mt-2"
					disabled={busy}
					onClick={() => onUnignore(rules)}
				>
					<Eye />
					Unignore all
				</Button>
			)}
		</details>
	);
}
