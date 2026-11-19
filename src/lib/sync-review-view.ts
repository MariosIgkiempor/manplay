import { z } from "zod";

/** How the sync review lays out its files: by album, or as the destination's folders. */
const reviewViewSchema = z.enum(["albums", "folders"]);
export type ReviewView = z.infer<typeof reviewViewSchema>;

export const DEFAULT_REVIEW_VIEW: ReviewView = "albums";

/** The view kept in storage, or the default when nothing valid is kept. */
export function parseReviewView(raw: unknown): ReviewView {
	const parsed = reviewViewSchema.safeParse(raw);
	return parsed.success ? parsed.data : DEFAULT_REVIEW_VIEW;
}
