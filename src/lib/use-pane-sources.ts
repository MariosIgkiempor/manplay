import { LIBRARY, type PaneSource } from "#/lib/drag-session.ts";
import { useSyncTargets } from "#/lib/queries.ts";

/**
 * What each pane shows. A destination that no longer exists falls back to the library, so a
 * remembered or linked pane never points at nothing.
 */
export function usePaneSources(first: number | undefined, second: number | null) {
	const destinations = useSyncTargets().data;
	const pick = (id: number | null | undefined): PaneSource =>
		id != null && destinations?.some((t) => t.id === id) === true
			? { kind: "remote", id }
			: LIBRARY;
	const nameOf = (source: PaneSource) => {
		if (source.kind === "library") {
			return "Library";
		}
		const t = destinations?.find((x) => x.id === source.id);
		return t ? [t.machine, ...t.path].join(" / ") : "destination";
	};
	const sources: [PaneSource, PaneSource] = [pick(first), pick(second)];
	return { sources, nameOf };
}
