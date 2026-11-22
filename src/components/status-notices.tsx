import { DuplicatesIndicator } from "#/components/duplicates.tsx";
import { IssuesIndicator } from "#/components/issues-drawer.tsx";
import { MissingIndicator } from "#/components/missing-files.tsx";
import { useDetail } from "#/context/detail-context.ts";

/** The library's problems that the side panel can list. */
type ProblemKind = "issues" | "duplicates" | "missing";

/**
 * The status bar's notices of the library's problems. Each opens its list in the side panel, and
 * closes it again while that list is the one showing.
 */
export function StatusNotices() {
	const detail = useDetail();
	const toggle = (kind: ProblemKind) => () =>
		detail.view?.kind === kind ? detail.close() : detail.open({ kind });
	return (
		<>
			<IssuesIndicator onClick={toggle("issues")} />
			<DuplicatesIndicator onClick={toggle("duplicates")} />
			<MissingIndicator onClick={toggle("missing")} />
		</>
	);
}
