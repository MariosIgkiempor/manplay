import { ErrorLine } from "#/components/page.tsx";
/** Error line for every failed mutation in `mutations`. */
export function MutationErrors({
	mutations,
}: {
	mutations: readonly { isError: boolean; error: unknown; submittedAt: number }[];
}) {
	return mutations.map(
		(m) => m.isError && <ErrorLine key={m.submittedAt}>{String(m.error)}</ErrorLine>,
	);
}
