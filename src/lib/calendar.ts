/** A calendar day; `month` runs 1 to 12. */
export interface CalendarDate {
	year: number;
	month: number;
	day: number;
}

/** One cell of a month grid. `inMonth` is false for the days borrowed from the next or last month. */
export interface CalendarDay extends CalendarDate {
	iso: string;
	inMonth: boolean;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_WEEK = 7;

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0");
}

/** `YYYY-MM-DD`, the format a date input reads and writes. */
export function formatIsoDate({ year, month, day }: CalendarDate): string {
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Reads `YYYY-MM-DD`; null when it is malformed or names a day that does not exist. */
export function parseIsoDate(value: string): CalendarDate | null {
	const match = ISO_DATE.exec(value);
	if (!match) {
		return null;
	}
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const real = new Date(year, month - 1, day);
	const exists =
		real.getFullYear() === year && real.getMonth() === month - 1 && real.getDate() === day;
	return exists ? { year, month, day } : null;
}

/** The date at local midnight, so formatting it for the user stays in their time zone. */
export function toLocalDate({ year, month, day }: CalendarDate): Date {
	return new Date(year, month - 1, day);
}

/** The month `delta` months from `year`/`month` (negative for earlier), across year ends. */
export function shiftMonth(
	year: number,
	month: number,
	delta: number,
): { year: number; month: number } {
	const shifted = new Date(year, month - 1 + delta, 1);
	return { year: shifted.getFullYear(), month: shifted.getMonth() + 1 };
}

/**
 * The month as whole weeks of seven days, padded with neighbouring days at both ends.
 * `weekStartsOn` is the weekday a row begins with: 0 for Sunday, 1 for Monday.
 */
export function monthWeeks(year: number, month: number, weekStartsOn: 0 | 1 = 1): CalendarDay[][] {
	const first = new Date(year, month - 1, 1);
	const lead = (first.getDay() - weekStartsOn + DAYS_IN_WEEK) % DAYS_IN_WEEK;
	const daysInMonth = new Date(year, month, 0).getDate();
	const weekCount = Math.ceil((lead + daysInMonth) / DAYS_IN_WEEK);
	const weeks: CalendarDay[][] = [];
	for (let week = 0; week < weekCount; week++) {
		const row: CalendarDay[] = [];
		for (let column = 0; column < DAYS_IN_WEEK; column++) {
			const cell = new Date(year, month - 1, 1 - lead + week * DAYS_IN_WEEK + column);
			const date = { year: cell.getFullYear(), month: cell.getMonth() + 1, day: cell.getDate() };
			row.push({ ...date, iso: formatIsoDate(date), inMonth: date.month === month });
		}
		weeks.push(row);
	}
	return weeks;
}
