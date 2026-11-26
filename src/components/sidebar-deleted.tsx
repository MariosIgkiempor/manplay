import { Link } from "@tanstack/react-router";
import { ArrowDownToLine, History } from "lucide-react";
import { RowCount, RowTrailing } from "#/components/sidebar-parts.tsx";
import { pageRow, rowBase, rowClass, useRowMatch } from "#/components/sidebar-row.ts";
import { compactCount } from "#/lib/format.ts";
import {
	useFileRemovals,
	useLibrarySyncStatus,
	useRecentlyDeleted,
	useSharingOn,
} from "#/lib/queries.ts";

/** Under Organise while the library is shared: what was deleted lately, with Restore. */
export function SidebarRecentlyDeleted() {
	const active = !!useRowMatch()({ to: "/deleted" });
	const count = useRecentlyDeleted().data?.length ?? 0;
	if (!useSharingOn()) {
		return null;
	}
	return (
		<div className={rowClass(active)}>
			<Link to="/deleted" className={rowBase} {...pageRow("Recently deleted")}>
				<span className="[&_svg]:size-4">
					<History />
				</span>
				<span className="truncate">Recently deleted</span>
				{count > 0 && <RowCount n={count} />}
			</Link>
		</div>
	);
}

/**
 * Under Organise while the library is shared: what other devices changed lately, with Undo. It
 * carries a count while deletions or removed songs wait to be let through or kept.
 */
export function SidebarLibraryChanges() {
	const active = !!useRowMatch()({ to: "/changes" });
	const held =
		(useLibrarySyncStatus().data?.hold?.count ?? 0) + (useFileRemovals().data?.length ?? 0);
	if (!useSharingOn()) {
		return null;
	}
	return (
		<div className={rowClass(active)}>
			<Link to="/changes" className={rowBase} {...pageRow("Changes")}>
				<span className="[&_svg]:size-4">
					<ArrowDownToLine />
				</span>
				<span className="truncate">Changes</span>
				{held > 0 && (
					<RowTrailing>
						<span className="text-warning">{compactCount(held)}</span>
					</RowTrailing>
				)}
			</Link>
		</div>
	);
}
