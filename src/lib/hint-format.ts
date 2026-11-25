/**
 * A hover hint's words, sorted into what the hint card shows: a title, lines of detail under it,
 * and the key that does the same thing. Hints are written as plain sentences where they are used
 * (`data-hint`); this reads the shape out of them, so every hint looks alike without each one
 * being laid out by hand.
 */
export interface HintParts {
	/** What the thing is or does, in a few words. A short hint is only this. */
	title: string;
	/** What else there is to know, one entry per line of the card. */
	detail: string[];
	/** The shortcut the hint ends with, e.g. `⌘Z`, without its brackets. */
	keys: string | null;
}

const MODIFIER_GLYPH = /[⌘⌥⇧⌃↵⌫⎋]/;
const NAMED_KEY =
	/^(?:(?:Ctrl|Alt|Shift|Cmd|Win)\+.+|Esc|Enter|Return|Space|Tab|Del|Delete|Backspace|F\d{1,2}|[A-Z0-9]|[?/[\]\\+\-−=,.])$/;

/** Whether the words in a hint's closing brackets name a key rather than add an aside. */
function isShortcut(inBrackets: string): boolean {
	const words = inBrackets.trim();
	return words.length <= 14 && (MODIFIER_GLYPH.test(words) || NAMED_KEY.test(words));
}

/** A closing `(⌘Z)` taken off the line, when it names a key. */
function splitKeys(line: string): { rest: string; keys: string | null } {
	const match = /^(.*?)\s*\(([^()]+)\)\s*\.?$/.exec(line);
	const inBrackets = match?.[2];
	if (match && inBrackets !== undefined && isShortcut(inBrackets)) {
		return { rest: (match[1] ?? "").trim(), keys: inBrackets.trim() };
	}
	return { rest: line, keys: null };
}

/** The longest a lead-in before a colon may be to count as a title, as in `Off: nothing moves`. */
const LONGEST_LEAD_IN = 28;

/** A first sentence as the title and the rest as detail, or a `Lead-in: rest` the same way. */
function splitTitle(line: string): { title: string; rest: string | null } {
	const sentenceEnd = /[.!?](?=\s+\S)/.exec(line);
	if (sentenceEnd) {
		const at = sentenceEnd.index;
		return { title: line.slice(0, at), rest: line.slice(at + 1).trim() };
	}
	const colon = line.indexOf(": ");
	if (colon > 0 && colon <= LONGEST_LEAD_IN) {
		return { title: line.slice(0, colon), rest: line.slice(colon + 2).trim() };
	}
	return { title: line.replace(/\.$/, ""), rest: null };
}

export function parseHint(text: string): HintParts {
	const [first = "", ...more] = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const { rest, keys } = splitKeys(first);
	const { title, rest: after } = splitTitle(rest);
	return { title, detail: [...(after ? [after] : []), ...more], keys };
}

const words = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Whether a hint only repeats what its element already shows in full (a title, a button's own
 * label). Such a hint says nothing new, so it is left out unless the text is cut off.
 */
export function repeatsVisibleText(hint: string, visible: string): boolean {
	const said = words(hint);
	return said !== "" && said === words(visible);
}
