import { useId } from "react";
import type { StreamedOnLeaving } from "#/lib/api.ts";

const OPTIONS: readonly { value: StreamedOnLeaving; label: string; hint: string }[] = [
	{
		value: "download",
		label: "Download them first (recommended)",
		hint: "Every one is downloaded into your library folder, then this device leaves. If any cannot be downloaded, nothing changes.",
	},
	{
		value: "keepUnplayable",
		label: "Keep them as unplayable entries",
		hint: "They stay in your playlists and tags, shown as unavailable. They play again after you join the library again.",
	},
	{
		value: "remove",
		label: "Remove them",
		hint: "They leave your library, with their places in playlists and tags. A copy of the database is saved first.",
	},
];

function songs(count: number): string {
	return count === 1 ? "1 song" : `${count.toLocaleString()} songs`;
}

/**
 * What becomes of the songs this device streams, asked where the device leaves the library they
 * play from. Shown only when there are any.
 */
export function StreamedLeaveChoice({
	count,
	value,
	onChange,
	disabled,
}: {
	count: number;
	value: StreamedOnLeaving;
	onChange: (next: StreamedOnLeaving) => void;
	disabled?: boolean;
}) {
	const name = useId();
	return (
		<fieldset className="mt-3 space-y-1.5" disabled={disabled}>
			<legend className="font-medium text-foreground text-sm">
				This device streams {songs(count)} from it. What happens to them?
			</legend>
			{OPTIONS.map((option) => (
				<label key={option.value} className="flex items-start gap-2 text-sm">
					<input
						type="radio"
						className="mt-1"
						name={name}
						checked={value === option.value}
						onChange={() => onChange(option.value)}
					/>
					<span>
						<span className="block text-foreground">{option.label}</span>
						<span className="block text-muted-foreground text-xs">{option.hint}</span>
					</span>
				</label>
			))}
		</fieldset>
	);
}
