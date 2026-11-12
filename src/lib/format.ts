const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
	["day", 86_400],
	["hour", 3600],
	["minute", 60],
];

/** "2 hours ago" style label for a unix timestamp in seconds. */
export function timeAgo(unixSeconds: number, nowMs: number = Date.now()): string {
	const diff = unixSeconds - Math.floor(nowMs / 1000);
	for (const [unit, secs] of UNITS) {
		if (Math.abs(diff) >= secs) {
			return rtf.format(Math.trunc(diff / secs), unit);
		}
	}
	return "just now";
}

/** m:ss for a duration in seconds. */
export function clock(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return "0:00";
	}
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

/** "4.2 MB" style file size. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) {
		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
