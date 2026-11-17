import { useState } from "react";
import {
	PrivateDialog,
	ScopeSwitch,
	type Shareable,
	ShareDialog,
} from "#/components/item-sharing.tsx";
import { useRefreshItems, useSharingOn } from "#/lib/queries.ts";

/**
 * Shared / Private for one tag, playlist or smart playlist, in its page header. Switching asks
 * first: sharing shows it to everyone, making it private removes it for everyone else. Shown only
 * while this device is in a shared library.
 */
export function SharingControl({ item }: { item: Shareable | null }) {
	const sharing = useSharingOn();
	const refresh = useRefreshItems();
	const [asking, setAsking] = useState<"share" | "private" | null>(null);
	if (!sharing || !item) {
		return null;
	}
	return (
		<>
			<ScopeSwitch
				value={item.scope}
				onChange={(next) => setAsking(next === "shared" ? "share" : "private")}
			/>
			{asking === "share" && (
				<ShareDialog item={item} onClose={() => setAsking(null)} onDone={refresh} />
			)}
			{asking === "private" && (
				<PrivateDialog item={item} onClose={() => setAsking(null)} onDone={refresh} />
			)}
		</>
	);
}
