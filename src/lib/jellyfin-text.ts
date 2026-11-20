import type { JellyfinPushSummary } from "#/lib/api.ts";
import { plural } from "#/lib/export-selection.ts";

/** What a push did, in words. */
export function pushSummaryText(s: JellyfinPushSummary): string {
	const done = [
		s.created > 0 && `${s.created} new`,
		s.updated > 0 && `${s.updated} updated`,
		s.renamed > 0 && `${s.renamed} renamed`,
		s.reshared > 0 && `${s.reshared} shared anew`,
		s.removed > 0 && `${s.removed} removed`,
	].filter(Boolean);
	const parts = [done.length > 0 ? done.join(", ") : "nothing changed"];
	if (s.waiting > 0) {
		parts.push(`${plural(s.waiting, "change")} waiting for review`);
	}
	if (s.failed.length > 0) {
		parts.push(`${s.failed.length} failed: ${s.failed[0]}`);
	}
	return parts.join(". ");
}
