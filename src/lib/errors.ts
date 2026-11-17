/** A backend error rewritten for the screen: what happened, and what to do about it. */
export type ErrorDescription = {
	title: string;
	detail: string | null;
};

type Rule = {
	pattern: RegExp;
	describe: (match: RegExpMatchArray) => ErrorDescription;
};

const UNREACHABLE_PREFIX = /^destination unreachable: /;

const RULES: readonly Rule[] = [
	{
		pattern: /^keychain: .*(User canceled|user cancell?ed|denied)/i,
		describe: () => ({
			title: "Keychain access was declined",
			detail:
				"manplay reads this destination's login from the keychain. Try again and choose Allow.",
		}),
	},
	{
		pattern: /^keychain: malformed/i,
		describe: () => ({
			title: "The saved login is unreadable",
			detail: "Remove the destination and add it again to save a fresh login.",
		}),
	},
	{
		pattern: /^keychain: /i,
		describe: () => ({
			title: "Could not read the keychain",
			detail: "Unlock your keychain, then try again.",
		}),
	},
];

/**
 * Turns the backend's raw message into a title and an optional next step. Messages with no rule
 * keep their own wording as the title, so nothing is ever hidden.
 */
export function describeError(raw: string): ErrorDescription {
	const message = raw.replace(/^Error: /, "").trim();
	if (UNREACHABLE_PREFIX.test(message)) {
		const cause = describeError(message.replace(UNREACHABLE_PREFIX, ""));
		return {
			title: "Destination unreachable",
			detail: cause.detail ?? cause.title,
		};
	}
	for (const { pattern, describe } of RULES) {
		const match = message.match(pattern);
		if (match) {
			return describe(match);
		}
	}
	return { title: message, detail: null };
}
