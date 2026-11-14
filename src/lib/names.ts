/** Separator between several names in one tag, as the backend writes it (`A; B`). */
export const NAME_SEPARATOR = "; ";

/** Names in a list tag: split on `;`, trimmed, empties dropped. */
export function splitNames(value: string): string[] {
	return value
		.split(";")
		.map((n) => n.trim())
		.filter((n) => n !== "");
}

export function joinNames(names: readonly string[]): string {
	return names.join(NAME_SEPARATOR);
}
