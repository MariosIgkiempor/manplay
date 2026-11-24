const SECTIONS = ["library", "analysis", "lookup", "appearance", "shortcuts", "about"] as const;

/** A tab of Settings. */
export type SettingsSection = (typeof SECTIONS)[number];

/** The tab a `?section=` value asks for, or null for anything that is not one. */
export function parseSettingsSection(value: unknown): SettingsSection | null {
	return SECTIONS.find((section) => section === value) ?? null;
}

/** The clashes' place on the Library settings, as a URL hash: where the sidebar's Clashes row lands. */
export const CLASHES_ANCHOR = "clashes";
