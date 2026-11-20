import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import type { HeaderMenuEntry } from "#/components/header-menu.tsx";
import { setJellyfinSelection, targetShortName } from "#/lib/api.ts";
import { type SelectionItem, selectionIncludes, toggleSelection } from "#/lib/export-selection.ts";
import { useJellyfinDestinations, useSyncTargets } from "#/lib/queries.ts";

/**
 * ⋯ rows that send a playlist, smart playlist or tag to each Jellyfin destination, ticked where
 * it goes now. They edit the same list as the destination's own chooser.
 */
export function useJellyfinMenu(item: SelectionItem | null): HeaderMenuEntry[] {
	const queryClient = useQueryClient();
	const destinations = useJellyfinDestinations();
	const targets = useSyncTargets();
	const save = useMutation({
		mutationFn: setJellyfinSelection,
		onSettled: () => queryClient.invalidateQueries({ queryKey: ["jellyfin-destinations"] }),
	});
	if (item === null) {
		return [];
	}
	return (destinations.data ?? []).map((d) => {
		const target = targets.data?.find((t) => t.id === d.targetId);
		const name = target ? targetShortName(target) : d.serverName;
		return {
			label: `Send to Jellyfin: ${name}`,
			icon: <Send />,
			checked: selectionIncludes(d.selection, item),
			disabled: save.isPending,
			hint: `Jellyfin on ${d.serverName}`,
			onSelect: () =>
				save.mutate({ targetId: d.targetId, selection: toggleSelection(d.selection, item) }),
		};
	});
}
