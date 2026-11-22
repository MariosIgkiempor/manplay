import { Popover } from "@base-ui/react/popover";
import { Scissors, X } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { applySplit, suggestSplits } from "#/lib/name-split.ts";
import { useDismissedSplits } from "#/lib/use-dismissed-splits.ts";

/**
 * Pills under a multi-artist field for names that look like several artists in one
 * (`A & B`). Pressing one splits it, and it goes away. The × asks whether the name is really
 * one artist and, if so, stops suggesting it.
 */
export function NameSplitPills({
	value,
	onChange,
}: {
	value: string;
	onChange: (next: string) => void;
}) {
	const { dismissed, dismiss } = useDismissedSplits();
	const splits = suggestSplits(value, dismissed);
	if (splits.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5 pt-1 pb-0.5 text-xs">
			{splits.map((suggestion) => (
				<span
					key={suggestion.name}
					className="group/pill inline-flex items-center rounded-full border border-primary/40 bg-primary/5 text-primary"
				>
					<button
						type="button"
						onClick={() => onChange(applySplit(value, suggestion))}
						data-hint={`Split into ${suggestion.parts.join(", ")}`}
						className="inline-flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 hover:bg-primary/10"
					>
						<Scissors className="size-3" />
						<span>Split</span>
						<span className="hidden max-w-64 truncate group-hover/pill:inline group-focus-within/pill:inline">
							→ {suggestion.parts.join(", ")}
						</span>
					</button>
					<Popover.Root>
						<Popover.Trigger
							aria-label={`Dismiss split suggestion for ${suggestion.name}`}
							className="mr-0.5 flex size-4 items-center justify-center rounded-full hover:bg-primary/10"
						>
							<X className="size-3" />
						</Popover.Trigger>
						<Popover.Portal>
							<Popover.Positioner sideOffset={6} className="z-50">
								<Popover.Popup
									className="z-50 w-64 space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground text-sm shadow-lg outline-none"
									onKeyDown={(ev) => ev.stopPropagation()}
								>
									<p>
										Treat <span className="font-medium">{suggestion.name}</span> as one artist?
									</p>
									<p className="text-muted-foreground text-xs">
										The split suggestion won't appear for this name again.
									</p>
									<Button size="sm" className="w-full" onClick={() => dismiss(suggestion.name)}>
										Don't suggest splitting
									</Button>
								</Popover.Popup>
							</Popover.Positioner>
						</Popover.Portal>
					</Popover.Root>
				</span>
			))}
		</div>
	);
}
