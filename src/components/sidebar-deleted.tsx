import { Link, useMatchRoute } from "@tanstack/react-router";
import { History } from "lucide-react";
import { RowCount } from "#/components/sidebar-parts.tsx";
import { rowBase, rowClass } from "#/components/sidebar-row.ts";
import { useRecentlyDeleted, useSharingOn } from "#/lib/queries.ts";

/** Under Organise while the library is shared: what was deleted lately, with Restore. */
export function SidebarRecentlyDeleted() {
	const active = !!useMatchRoute()({ to: "/deleted" });
	const count = useRecentlyDeleted().data?.length ?? 0;
	if (!useSharingOn()) {
		return null;
	}
	return (
		<div className={rowClass(active)}>
			<Link to="/deleted" className={rowBase}>
				<span className="[&_svg]:size-4">
					<History />
				</span>
				<span className="truncate">Recently deleted</span>
				{count > 0 && <RowCount n={count} />}
			</Link>
		</div>
	);
}
