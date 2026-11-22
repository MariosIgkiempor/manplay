import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Disc3, FolderTree } from "lucide-react";
import type { ReactNode } from "react";
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
		<Menu.Root>
			<Menu.Trigger
				data-slot="button"
				data-variant="outline"
				aria-label={`View: ${VIEWS[view].label}`}
				className="flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-muted data-[popup-open]:text-foreground [&_svg]:size-3.5"
			>
				{VIEWS[view].icon}
				{VIEWS[view].label}
				<ChevronDown />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={4} align="end" className="z-50">
					<Menu.Popup className="w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
						<Menu.RadioGroup value={view} onValueChange={(v: ReviewView) => onView(v)}>
							{(Object.keys(VIEWS) as ReviewView[]).map((v) => (
								<Menu.RadioItem key={v} value={v} className={item} closeOnClick>
									<span className="text-muted-foreground">{VIEWS[v].icon}</span>
									<span className="flex-1">{VIEWS[v].label}</span>
									<Menu.RadioItemIndicator className="text-primary">
										<Check />
									</Menu.RadioItemIndicator>
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
						<Menu.Separator className="my-1 border-t" />
						<Menu.CheckboxItem
							checked={showUnchanged}
							onCheckedChange={onShowUnchanged}
							disabled={view !== "folders"}
							title={view === "folders" ? undefined : "Folders view only"}
							className={item}
						>
							<span className="flex-1">Show unchanged folders</span>
							<Menu.CheckboxItemIndicator
								keepMounted
								className="text-primary data-[unchecked]:invisible"
							>
								<Check />
							</Menu.CheckboxItemIndicator>
						</Menu.CheckboxItem>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
