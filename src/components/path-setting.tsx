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
