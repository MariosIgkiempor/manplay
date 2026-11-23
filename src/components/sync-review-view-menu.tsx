import {
	MenuCheckboxItem,
	MenuItemIndicator,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
} from "@ui-sdk/react/menu";
import { Check, ChevronDown, Disc3, FolderTree } from "lucide-react";
import type { ReactNode } from "react";
import { MenuPopup, MenuRoot } from "#/components/ui/popup.tsx";
import type { ReviewView } from "#/lib/sync-review-view.ts";

const VIEWS: Record<ReviewView, { label: string; icon: ReactNode }> = {
	albums: { label: "Albums", icon: <Disc3 /> },
	folders: { label: "Folders", icon: <FolderTree /> },
};

const item =
	"flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0";

/** How the sync review shows its files, as a button that opens the view and its options. */
export function ReviewViewMenu({
	view,
	onView,
	showUnchanged,
	onShowUnchanged,
}: {
	view: ReviewView;
	onView: (v: ReviewView) => void;
	showUnchanged: boolean;
	onShowUnchanged: (on: boolean) => void;
}) {
	return (
		<MenuRoot>
			<MenuTrigger
				data-slot="button"
				data-variant="outline"
				aria-label={`View: ${VIEWS[view].label}`}
				className="flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[open]:bg-muted data-[open]:text-foreground [&_svg]:size-3.5"
			>
				{VIEWS[view].icon}
				{VIEWS[view].label}
				<ChevronDown />
			</MenuTrigger>
			<MenuPopup
				sideOffset={4}
				align="end"
				className="w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
			>
				<MenuRadioGroup value={view} onValueChange={(v: ReviewView) => onView(v)}>
					{(Object.keys(VIEWS) as ReviewView[]).map((v) => (
						<MenuRadioItem key={v} value={v} className={item} closeOnSelect>
							<span className="text-muted-foreground">{VIEWS[v].icon}</span>
							<span className="flex-1">{VIEWS[v].label}</span>
							<MenuItemIndicator className="text-primary">
								<Check />
							</MenuItemIndicator>
						</MenuRadioItem>
					))}
				</MenuRadioGroup>
				<MenuSeparator className="my-1 border-t" />
				<MenuCheckboxItem
					value="show-unchanged"
					checked={showUnchanged}
					onCheckedChange={onShowUnchanged}
					disabled={view !== "folders"}
					data-hint={view === "folders" ? undefined : "Folders view only"}
					className={item}
				>
					<span className="flex-1">Show unchanged folders</span>
					<MenuItemIndicator keepMounted className="text-primary data-[unchecked]:invisible">
						<Check />
					</MenuItemIndicator>
				</MenuCheckboxItem>
			</MenuPopup>
		</MenuRoot>
	);
}
