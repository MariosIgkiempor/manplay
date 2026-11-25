/**
 * Compares two strings for sorting, ignoring case and accents (`é` sorts with `e`). One collator
 * is made once and shared: `localeCompare` with options builds a new one on every call, which
 * made sorting a large library take a noticeable moment.
 */
export const compareText: (a: string, b: string) => number = new Intl.Collator(undefined, {
	sensitivity: "base",
}).compare;
