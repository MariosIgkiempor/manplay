import { describe, expect, it } from "vitest";
import { answerConfirm, askConfirm } from "./confirm.ts";

const QUESTION = { title: "Remove it?", confirmLabel: "Remove" };

describe("askConfirm", () => {
	it.each([true, false])("resolves to the answer %s", async (answer) => {
		const asked = askConfirm(QUESTION);
		answerConfirm(answer);
		await expect(asked).resolves.toBe(answer);
	});

	it("leaves a question unconfirmed when another replaces it", async () => {
		const first = askConfirm(QUESTION);
		const second = askConfirm(QUESTION);
		await expect(first).resolves.toBe(false);
		answerConfirm(true);
		await expect(second).resolves.toBe(true);
	});

	it("ignores an answer when nothing is asked", () => {
		expect(() => answerConfirm(true)).not.toThrow();
	});
});
