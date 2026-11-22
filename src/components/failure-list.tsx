import { TriangleAlert } from "lucide-react";

/** Reasons the sync reports, in words that say what happened to the file. */
const FRIENDLY: [RegExp, { title: string; detail: string }][] = [
	[
		/^destination path already exists$/,
		{
			title: "A file is already at the new path",
			detail: "Nothing was overwritten. Remove or rename the file that is there, then sync again.",
		},
	],
	[
		/^source changed since review$/,
		{
			title: "The file changed after the review",
			detail:
				"Someone edited it on the destination while you were reviewing. Sync again to compare.",
		},
	],
	[
		/^not changed, backup failed/,
		{
			title: "The backup failed, so the file was left alone",
			detail: "Free up space or check access to the backup folder, then sync again.",
		},
	],
];

function friendly(reason: string): { title: string; detail: string | null } {
	const hit = FRIENDLY.find(([re]) => re.test(reason))?.[1];
	return hit ?? { title: reason, detail: null };
}

/** Splits `folder/song.mp3: reason` into its path and its reason. */
function split(message: string): { path: string; reason: string } {
	const at = message.search(/\.[A-Za-z0-9]{2,5}: /);
	if (at < 0) {
		return { path: "", reason: message };
	}
	const cut = message.indexOf(": ", at);
	return { path: message.slice(0, cut), reason: message.slice(cut + 2) };
}

/** A failed file's full path on one line: folders and extension dimmed, the name in full strength. */
function FailureRow({ path, raw }: { path: string; raw: string }) {
	const slash = path.lastIndexOf("/") + 1;
	const dot = path.lastIndexOf(".");
	const hasExt = dot > slash;
	return (
		<li
			data-hint={path || raw}
			className="break-all px-[var(--diff-inset,0px)] py-1.5 font-mono text-[0.8rem] leading-snug"
		>
			{path ? (
				<>
					<span className="text-muted-foreground">{path.slice(0, slash)}</span>
					{path.slice(slash, hasExt ? dot : undefined)}
					{hasExt && <span className="text-muted-foreground">{path.slice(dot)}</span>}
				</>
			) : (
				raw
			)}
		</li>
	);
}

/**
 * What failed and why: grouped by reason, each file as its name over its folder. `total` can be
 * more than the messages, which the sync caps.
 */
export function FailureList({
	messages,
	total,
	outcome,
	heading = true,
}: {
	messages: readonly string[];
	total: number;
	/** What happened to the files that failed, such as "left unchanged". */
	outcome?: string | undefined;
	/** Show the "N failed" line; a caller that already says so can leave it out. */
	heading?: boolean;
}) {
	const groups = new Map<
		string,
		{ detail: string | null; files: { path: string; raw: string }[] }
	>();
	for (const m of messages) {
		const { path, reason } = split(m);
		const { title, detail } = friendly(reason);
		const group = groups.get(title) ?? { detail, files: [] };
		group.files.push({ path, raw: reason });
		groups.set(title, group);
	}
	return (
		<section className="space-y-4">
			{heading && (
				<h4 className="flex items-center gap-2 font-medium text-destructive text-sm">
					<TriangleAlert className="size-4 shrink-0" />
					{total.toLocaleString()} failed{outcome ? `, ${outcome}` : ""}
				</h4>
			)}
			{[...groups].map(([title, { detail, files }]) => (
				<div key={title} className="space-y-1.5">
					<div>
						<p className="font-medium text-sm">
							{title} <span className="font-normal text-muted-foreground">· {files.length}</span>
						</p>
						{detail && <p className="text-muted-foreground text-xs">{detail}</p>}
					</div>
					{/* Runs to the edges of the container, whatever padding the caller gave it. */}
					<ul className="-mx-[var(--diff-inset,0px)] divide-y divide-border/60 border-t">
						{files.map((f) => (
							<FailureRow key={f.path || f.raw} path={f.path} raw={f.raw} />
						))}
					</ul>
				</div>
			))}
			{total > messages.length && (
				<p className="text-muted-foreground text-xs">
					and {(total - messages.length).toLocaleString()} more not listed
				</p>
			)}
		</section>
	);
}
