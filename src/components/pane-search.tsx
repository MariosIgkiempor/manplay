import { Search } from "lucide-react";
import { Input } from "#/components/ui/input.tsx";

/** The `/` find box of a file pane. */
export function PaneSearch({
	value,
	onType,
	onEnd,
	onBlur,
}: {
	/** Text in the box; `null` hides it. */
	value: string | null;
	onType: (text: string) => void;
	onEnd: (keep: boolean) => void;
	onBlur: () => void;
}) {
	if (value === null) {
		return null;
	}
	return (
		<div className="flex items-center gap-2 border-b px-3 py-1.5">
			<Search className="size-4 shrink-0 text-muted-foreground" />
			<Input
				autoFocus
				value={value}
				placeholder="Find in this view… (Enter keeps, Esc cancels)"
				className="h-7"
				onChange={(ev) => onType(ev.target.value)}
				onKeyDown={(ev) => {
					ev.stopPropagation();
					if (ev.key === "Enter" || ev.key === "Escape") {
						ev.preventDefault();
						onEnd(ev.key === "Enter");
					}
				}}
				onBlur={onBlur}
			/>
		</div>
	);
}
