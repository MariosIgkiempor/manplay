import { Link } from "@tanstack/react-router";
import { Database, Download, FolderTree, Library, Music, Settings, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarDrives } from "#/components/sidebar-drives.tsx";
import { SidebarPlaylists } from "#/components/sidebar-playlists.tsx";
import { SidebarTagTree } from "#/components/sidebar-tag-tree.tsx";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { useUpdateCheck } from "#/lib/updater.ts";

const linkClass =
	"flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground";
const activeProps = { className: "bg-muted font-medium text-foreground" } as const;

function NavLink({
	children,
	...props
}: {
	to: "/" | "/files" | "/import" | "/export" | "/metadata" | "/settings";
	children: ReactNode;
}) {
	return (
		<Link
			{...props}
			className={linkClass}
			activeOptions={{ exact: true }}
			activeProps={activeProps}
		>
			{children}
		</Link>
	);
}

export function Sidebar() {
	const syncing = useSyncProgress().size > 0;
	const updateAvailable = useUpdateCheck().data != null;
	return (
		<aside className="flex w-60 shrink-0 flex-col gap-4 border-r bg-card/40 p-3">
			<div className="flex items-center gap-2 px-2 pt-1 font-semibold">
				<Music className="size-5 text-primary" />
				manplay
			</div>
			<nav className="space-y-0.5">
				<NavLink to="/">
					<Library className="size-4" />
					Library
				</NavLink>
				<NavLink to="/files">
					<FolderTree className="size-4" />
					Files
				</NavLink>
				<NavLink to="/metadata">
					<Database className="size-4" />
					Metadata
				</NavLink>
				<NavLink to="/import">
					<Download className="size-4" />
					Import
				</NavLink>
				<NavLink to="/export">
					<Upload className="size-4" />
					Export
					{syncing && <span className="ml-auto size-2 animate-pulse rounded-full bg-primary" />}
				</NavLink>
			</nav>
			<div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
				<SidebarDrives />
				<SidebarPlaylists />
				<SidebarTagTree />
			</div>
			<nav className="border-t pt-2">
				<NavLink to="/settings">
					<Settings className="size-4" />
					Settings
					{updateAvailable && (
						<span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
							Update
						</span>
					)}
				</NavLink>
			</nav>
		</aside>
	);
}
