import type { ReactNode } from "react";

/** A folder or file setting: the current path (or a hint when unset) and its actions. */
export function PathSetting({
	path,
	emptyHint,
	children,
}: {
	path: string | null;
	emptyHint: string;
	children: ReactNode;
}) {
	return (
		<div className="space-y-3">
			{path === null ? (
				<p className="text-muted-foreground text-sm">{emptyHint}</p>
			) : (
				<p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{path}</p>
			)}
			<div className="flex flex-wrap gap-2">{children}</div>
		</div>
	);
}

/** Error line for every failed mutation in `mutations`. */
export function MutationErrors({
	mutations,
}: {
	mutations: readonly { isError: boolean; error: unknown; submittedAt: number }[];
}) {
	return mutations.map(
		(m) =>
			m.isError && (
				<p key={m.submittedAt} className="text-destructive text-sm">
					{String(m.error)}
				</p>
			),
	);
}
