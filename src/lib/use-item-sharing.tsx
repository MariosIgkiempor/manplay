import { useMutation } from "@tanstack/react-query";
import { EyeOff, Lock, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { PrivateDialog, type Shareable, ShareDialog } from "#/components/item-sharing.tsx";
import type { MenuEntry } from "#/components/menu.tsx";
import { type Scope, setItemHidden } from "#/lib/api.ts";
import { useDefaultScope, useRefreshItems, useSharingOn } from "#/lib/queries.ts";

/**
 * The Share / Make private / Hide entries for an item's context menu, and the dialogs they open
 * (render `dialogs` once). Nothing private becomes shared without the confirmation.
 */
export function useItemSharing() {
	const refresh = useRefreshItems();
	const [asking, setAsking] = useState<{ item: Shareable; what: "share" | "private" } | null>(null);
	const hide = useMutation({
		mutationFn: ({ item, hidden }: { item: Shareable; hidden: boolean }) =>
			setItemHidden(item.kind, item.id, hidden),
		onSettled: refresh,
	});
	const entries = (item: Shareable): MenuEntry[] => [
		item.scope === "local"
			? { label: "Share…", icon: <Users />, onSelect: () => setAsking({ item, what: "share" }) }
			: {
					label: "Make private…",
					icon: <Lock />,
					onSelect: () => setAsking({ item, what: "private" }),
				},
		{ label: "Hide", icon: <EyeOff />, onSelect: () => hide.mutate({ item, hidden: true }) },
	];
	const dialogs: ReactNode =
		asking &&
		(asking.what === "share" ? (
			<ShareDialog item={asking.item} onClose={() => setAsking(null)} onDone={refresh} />
		) : (
			<PrivateDialog item={asking.item} onClose={() => setAsking(null)} onDone={refresh} />
		));
	return {
		entries,
		dialogs,
		error: hide.error,
		unhide: (item: Shareable) => hide.mutate({ item, hidden: false }),
	};
}

/**
 * Shared or private for a tag or playlist about to be created: starts at the library default and
 * can be flipped in the new-item row. `prop` is undefined outside a shared library, so the row
 * shows no switch and the item gets the default.
 */
export function useNewItemScope() {
	const sharing = useSharingOn();
	const { scope: fallback } = useDefaultScope();
	const [picked, setPicked] = useState<Scope | null>(null);
	const shown: Scope = picked ?? fallback.data ?? "shared";
	return {
		/** What to create with: only a scope the user chose; otherwise the library default applies. */
		value: picked ?? undefined,
		prop: sharing ? { value: shown, onChange: setPicked } : undefined,
		/** Back to the default, for the next new row. */
		reset: () => setPicked(null),
	};
}
