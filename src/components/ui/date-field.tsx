import { Popover, PopoverTrigger } from "@ui-sdk/react/popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { PopoverPopup } from "#/components/ui/popup.tsx";
import {
	type CalendarDate,
	formatIsoDate,
	monthWeeks,
	parseIsoDate,
	shiftMonth,
	toLocalDate,
} from "#/lib/calendar.ts";
import { pickerTrigger } from "#/lib/menu-styles.ts";
import { cn } from "#/lib/utils.ts";

const WEEK_STARTS_ON = 1;

function todayLocal(): CalendarDate {
	const now = new Date();
	return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** Short weekday names in the user's language, in the order the calendar's columns run. */
function weekdayNames(): string[] {
	const format = new Intl.DateTimeFormat(undefined, { weekday: "short" });
	// 2024-01-01 was a Monday.
	return Array.from({ length: 7 }, (_, i) =>
		format.format(new Date(2024, 0, WEEK_STARTS_ON === 1 ? 1 + i : i)),
	);
}

/**
 * Picks a day: a button showing the date in the user's language that opens a month calendar.
 * The value is `YYYY-MM-DD` (or empty for none), the same text a native date input holds.
 */
export function DateField({
	value,
	onChange,
	label,
	clearable = true,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	label: string;
	/** Shows a Clear button that sets the value to empty. */
	clearable?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const chosen = parseIsoDate(value);
	const text = chosen
		? toLocalDate(chosen).toLocaleDateString(undefined, { dateStyle: "medium" })
		: "Pick a date";
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				aria-label={`${label}: ${text}`}
				className={cn(pickerTrigger, !chosen && "text-muted-foreground", className)}
			>
				<CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate tabular-nums">{text}</span>
			</PopoverTrigger>
			<PopoverPopup
				sideOffset={4}
				align="start"
				aria-label={label}
				className="w-64 rounded-lg border bg-popover p-2 text-popover-foreground text-sm shadow-lg outline-none"
			>
				<MonthCalendar
					chosen={chosen}
					onPick={(date) => {
						onChange(formatIsoDate(date));
						setOpen(false);
					}}
					onClear={
						clearable
							? () => {
									onChange("");
									setOpen(false);
								}
							: undefined
					}
				/>
			</PopoverPopup>
		</Popover>
	);
}

const NAV_BUTTON =
	"grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

function MonthCalendar({
	chosen,
	onPick,
	onClear,
}: {
	chosen: CalendarDate | null;
	onPick: (date: CalendarDate) => void;
	onClear: (() => void) | undefined;
}) {
	const today = useMemo(todayLocal, []);
	const [shown, setShown] = useState({
		year: (chosen ?? today).year,
		month: (chosen ?? today).month,
	});
	const weeks = monthWeeks(shown.year, shown.month, WEEK_STARTS_ON);
	const weekdays = useMemo(weekdayNames, []);
	const title = toLocalDate({ ...shown, day: 1 }).toLocaleDateString(undefined, {
		month: "long",
		year: "numeric",
	});
	const chosenIso = chosen ? formatIsoDate(chosen) : null;
	const todayIso = formatIsoDate(today);
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<button
					type="button"
					aria-label="Previous month"
					className={NAV_BUTTON}
					onClick={() => setShown(shiftMonth(shown.year, shown.month, -1))}
				>
					<ChevronLeft className="size-4" />
				</button>
				<span className="font-medium" aria-live="polite">
					{title}
				</span>
				<button
					type="button"
					aria-label="Next month"
					className={NAV_BUTTON}
					onClick={() => setShown(shiftMonth(shown.year, shown.month, 1))}
				>
					<ChevronRight className="size-4" />
				</button>
			</div>
			<div className="grid grid-cols-7 text-center text-muted-foreground text-xs">
				{weekdays.map((name) => (
					<span key={name} className="py-1">
						{name}
					</span>
				))}
			</div>
			<div className="grid grid-cols-7 gap-y-0.5">
				{weeks.flat().map((day) => (
					<button
						key={day.iso}
						type="button"
						aria-pressed={day.iso === chosenIso}
						aria-label={toLocalDate(day).toLocaleDateString(undefined, { dateStyle: "full" })}
						onClick={() => onPick(day)}
						className={cn(
							"grid h-8 place-items-center rounded-md text-sm tabular-nums outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
							!day.inMonth && "text-muted-foreground/50",
							day.iso === todayIso && "font-semibold text-primary",
							day.iso === chosenIso && "bg-primary text-primary-foreground hover:bg-primary",
						)}
					>
						{day.day}
					</button>
				))}
			</div>
			{onClear && (
				<div className="flex justify-end pt-1">
					<button
						type="button"
						onClick={onClear}
						className="rounded-md px-2 py-1 text-muted-foreground text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						Clear
					</button>
				</div>
			)}
		</div>
	);
}
