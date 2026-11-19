import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight, ChevronsUpDown, Folder } from "lucide-react";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { isR2, type SyncTarget, targetShortName } from "#/lib/api.ts";
import { useLibraryRoot, useSyncTargets } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

const LIBRARY = "library";

export const brandOf = (t: SyncTarget): Brand => (isR2(t) ? "cloudflare" : "tailscale");

/**
 * A folder path as a trail: a folder glyph, then each folder with a small chevron between. The
 * last folder is the one you land in, so it is the strongest; long paths keep their start and end.
 */
function PathTrail({ segments, empty }: { segments: readonly string[]; empty: string }) {
	if (segments.length === 0) {
		return (
			<span className="flex items-center gap-1 text-muted-foreground text-xs">
				<Folder className="size-3 shrink-0" />
				{empty}
			</span>
		);
	}
	const MAX = 3;
	const shown = segments.length > MAX ? ["…", ...segments.slice(-(MAX - 1))] : [...segments];
	return (
		<span
			className="flex min-w-0 items-center gap-0.5 text-muted-foreground text-xs"
			title={segments.join(" / ")}
		>
			<Folder className="mr-0.5 size-3 shrink-0" />
			{shown.map((seg, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a path can repeat a folder name
				<span key={`${i}-${seg}`} className="flex min-w-0 items-center gap-0.5">
					{i > 0 && <ChevronRight className="size-3 shrink-0 opacity-50" />}
					<span
						className={cn(
							"truncate",
							i === shown.length - 1 && "font-medium text-foreground/80",
							seg === "…" && "shrink-0",
						)}
					>
						{seg}
					</span>
				</span>
			))}
		</span>
	);
}

const rootFolders = (root: string | null | undefined) =>
	(root ?? "").split(/[\\/]/).filter((s) => s !== "");

const item =
	"flex cursor-default items-center gap-3 rounded-md px-2 py-2 outline-none data-[highlighted]:bg-muted";

/**
 * Chooses what the Files page shows: the library folder or any connected destination. It sits in
 * the page header's segmented control, so it takes the group's outline instead of drawing its own.
 */
const CRUMB =
	"flex h-6 max-w-48 items-center gap-1.5 rounded-md px-1 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 data-[popup-open]:bg-muted";

/**
 * Chooses what a Files pane shows, the library folder or any connected destination, as the first
 * crumb of the pane's path. Choosing what is already shown goes back to its top folder.
 */
export function FilesSourcePicker({
	value: target,
	onChange,
	onTop,
}: {
	/** The destination shown, or `undefined` for the library. */
	value: number | undefined;
	onChange: (id: number | undefined) => void;
	/** Goes to the top folder of what is shown. */
	onTop: () => void;
}) {
	const targets = useSyncTargets().data ?? [];
	const library = useLibraryRoot().data;
	const current = targets.find((t) => t.id === target);
	const icon = (
		<BrandIcon brand={current ? brandOf(current) : "library"} className="size-4 rounded-[4px]" />
	);
	const name = current ? targetShortName(current) : "Library";
	if (targets.length === 0) {
		return (
			<button type="button" className={cn(CRUMB, "font-medium")} onClick={onTop}>
				{icon}
				<span className="min-w-0 truncate">{name}</span>
			</button>
		);
	}
	const selected = current ? String(current.id) : LIBRARY;
	const pick = (value: string) =>
		value === selected ? onTop() : onChange(value === LIBRARY ? undefined : Number(value));
	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label="Choose what to browse"
				title={current ? `${current.machine}: ${current.path.join(" / ")}` : (library ?? undefined)}
				className={CRUMB}
			>
				{icon}
				<span className="min-w-0 truncate font-medium">{name}</span>
				<ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={6} align="start" className="z-50">
					<Menu.Popup className="w-80 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
						<Menu.RadioGroup value={selected}>
							<Menu.RadioItem
								value={LIBRARY}
								className={item}
								closeOnClick
								onClick={() => pick(LIBRARY)}
							>
								<BrandIcon brand="library" className="size-9" />
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="text-sm font-medium">Library</span>
									<PathTrail segments={rootFolders(library)} empty="No folder chosen" />
								</span>
								<Menu.RadioItemIndicator className="text-primary">
									<Check className="size-4" />
								</Menu.RadioItemIndicator>
							</Menu.RadioItem>
							<Menu.Group>
								<Menu.GroupLabel className="px-2 pt-2.5 pb-1 text-muted-foreground text-xs">
									Destinations
								</Menu.GroupLabel>
								{targets.map((t) => (
									<Menu.RadioItem
										key={t.id}
										value={String(t.id)}
										className={item}
										closeOnClick
										onClick={() => pick(String(t.id))}
									>
										<BrandIcon brand={brandOf(t)} className="size-9" />
										<span className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="truncate text-sm font-medium">{targetShortName(t)}</span>
											<PathTrail
												segments={t.path}
												empty={isR2(t) ? "Bucket root" : "Whole share"}
											/>
										</span>
										<Menu.RadioItemIndicator className="text-primary">
											<Check className="size-4" />
										</Menu.RadioItemIndicator>
									</Menu.RadioItem>
								))}
							</Menu.Group>
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
