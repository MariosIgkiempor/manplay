import type { JellyfinUserId, JellyfinVisibility } from "#/lib/api.ts";

/**
 * The choice as the backend stores it: users sorted and once each, the owner left out (they see
 * their own playlists anyway), and nobody left meaning only the owner.
 */
export function normaliseVisibility(
	visibility: JellyfinVisibility,
	owner: JellyfinUserId | null,
): JellyfinVisibility {
	if (visibility.kind !== "users") {
		return visibility;
	}
	const users = [...new Set(visibility.users.filter((u) => u !== owner))].sort();
	return users.length === 0 ? { kind: "onlyMe" } : { kind: "users", users };
}

export function sameVisibility(
	a: JellyfinVisibility,
	b: JellyfinVisibility,
	owner: JellyfinUserId | null,
): boolean {
	return (
		JSON.stringify(normaliseVisibility(a, owner)) === JSON.stringify(normaliseVisibility(b, owner))
	);
}

/** The visibility with one user ticked or unticked; ticking from another kind starts a list. */
export function toggleViewer(
	visibility: JellyfinVisibility,
	user: JellyfinUserId,
): JellyfinVisibility {
	const users = visibility.kind === "users" ? visibility.users : [];
	return {
		kind: "users",
		users: users.includes(user) ? users.filter((u) => u !== user) : [...users, user],
	};
}
