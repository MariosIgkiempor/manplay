/** Status-bar text with a progress bar; `total` of 0 shows an indeterminate pulse. */
export function ProgressPill({
	label,
	done,
	total,
}: {
	label: string;
	done: number;
	total: number;
}) {
	const percent = total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
	return (
		<div className="flex items-center gap-2 text-primary">
			<span className="tabular-nums">
				{label}
				{total > 0 && ` ${done}/${total}`}
			</span>
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				className="h-1.5 w-32 overflow-hidden rounded-full bg-primary/20"
			>
				<div
					className={`h-full rounded-full bg-primary transition-[width] duration-200 ${total === 0 ? "animate-pulse" : ""}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	);
}
