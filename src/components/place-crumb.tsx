import { Menu } from "@base-ui/react/menu";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronRight, ChevronsUpDown, Plus } from "lucide-react";
import { BrandIcon } from "#/components/brand-icon.tsx";
import {
	type PlaceKey,
	type PlaceSection,
	useExportPlaces,
	useImportPlaces,
} from "#/lib/places.ts";

const item =
	"flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-foreground text-sm outline-none data-[highlighted]:bg-muted";

/**
 * `Export › <destination ▾>` (or `Import › <source ▾>`) at the top of a source's or destination's
 * page: the section leads back to its overview, the menu jumps to a sibling.
 */
export function PlaceCrumb({
	section,
	current,
	label,
}: {
	section: PlaceSection;
	current: PlaceKey;
	/** What the menu button says, when the current place is not in the list (e.g. Add). */
	label?: string;
}) {
	const navigate = useNavigate();
	const exportPlaces = useExportPlaces();
	const importPlaces = useImportPlaces();
	const places = section === "export" ? exportPlaces : importPlaces;
	const here = places.find((p) => p.key === current);
	const title = section === "export" ? "Export" : "Import";
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			<Link
				to={section === "export" ? "/export" : "/import"}
				className="hover:text-foreground hover:underline"
			>
				{title}
			</Link>
			<ChevronRight className="size-3.5 shrink-0" />
			<Menu.Root>
				<Menu.Trigger
					aria-label={`Other ${section === "export" ? "destinations" : "sources"}`}
					className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
				>
					<span className="truncate">{here?.label ?? label ?? title}</span>
					<ChevronsUpDown className="size-3.5 shrink-0" />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner sideOffset={4} align="start" className="z-50">
						<Menu.Popup className="min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
							{places.map((p) => (
								<Menu.Item key={p.key} className={item} onClick={p.go}>
									<BrandIcon brand={p.brand} className="size-4 rounded-[4px] ring-0" />
									<span className="flex-1 truncate">{p.label}</span>
									{p.key === current && <Check className="size-3.5 text-primary" />}
								</Menu.Item>
							))}
							{section === "export" && (
								<>
									{places.length > 0 && <Menu.Separator className="-mx-1 my-1 h-px bg-border" />}
									<Menu.Item
										className={item}
										onClick={() => void navigate({ to: "/export/add", search: {} })}
									>
										<Plus className="size-4 text-muted-foreground" />
										<span className="flex-1">Add destination…</span>
										{current === "add" && <Check className="size-3.5 text-primary" />}
									</Menu.Item>
								</>
							)}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</span>
	);
}
