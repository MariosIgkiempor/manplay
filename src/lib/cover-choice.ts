import type { CoverOption } from "#/lib/api.ts";

/** The picture formats a cover can be written from. */
export const COVER_TYPES: readonly string[] = ["image/jpeg", "image/png"];

/** What tells one release of an album from another: its year, country and format. */
export function optionCaption(option: CoverOption): string {
	const parts = [option.year, option.country, option.format].filter(
		(part) => part !== null && part !== "",
	);
	return parts.length > 0 ? parts.join(", ") : option.title;
}

/**
 * Where finding a cover online stands, which is what the Download button says and how it is
 * coloured:
 * - `idle`: not asked for.
 * - `ask`: lookups are off, so the user is asked before the album's name is sent out.
 * - `searching`: looking for releases of the album.
 * - `loading`: a release was found and its picture is on its way.
 * - `none`: no release has a cover.
 * - `failed`: the search did not go through.
 * - `ready`: a cover is showing, waiting to be confirmed or cancelled.
 */
export type DownloadStage = "idle" | "ask" | "searching" | "loading" | "none" | "failed" | "ready";

export function downloadStage(now: {
	/** Download was pressed. */
	asked: boolean;
	/** Lookups are switched on. */
	allowed: boolean;
	searching: boolean;
	failed: boolean;
	/** How many found releases may still have a cover; null until the search has answered. */
	candidates: number | null;
	/** The picture of the release in view has arrived. */
	loaded: boolean;
}): DownloadStage {
	if (!now.asked) {
		return "idle";
	}
	if (!now.allowed) {
		return "ask";
	}
	if (now.searching) {
		return "searching";
	}
	if (now.failed) {
		return "failed";
	}
	if (now.candidates === null) {
		return "searching";
	}
	if (now.candidates === 0) {
		return "none";
	}
	return now.loaded ? "ready" : "loading";
}
