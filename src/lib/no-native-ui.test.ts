import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The app draws all of its own UI: no system file pickers or message boxes, no browser tooltips,
 * dropdowns, suggestion lists or calendars. This reads the source and fails when one comes back.
 */

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Elements that open a popup the browser draws, with what to use instead. */
const NATIVE_ELEMENTS: Readonly<Record<string, string>> = {
	select: "Select (ui/select.tsx) or Picker",
	option: "Select (ui/select.tsx) or Picker",
	datalist: "SuggestInput (ui/suggest-input.tsx)",
	dialog: "Dialog (confirm-dialog.tsx)",
};

/** Input types that open a picker the browser or system draws. */
const NATIVE_INPUT_TYPES: Readonly<Record<string, string>> = {
	date: "DateField (ui/date-field.tsx)",
	"datetime-local": "DateField (ui/date-field.tsx)",
	month: "DateField (ui/date-field.tsx)",
	week: "DateField (ui/date-field.tsx)",
	time: "an app-drawn field",
	color: "an app-drawn field",
	file: "pickPath (lib/file-picker.ts)",
};

/** Code that opens a system dialog. */
const NATIVE_CALLS: readonly [pattern: RegExp, instead: string][] = [
	[/@tauri-apps\/plugin-dialog/, "pickPath (lib/file-picker.ts) or askConfirm (lib/confirm.ts)"],
	[/\bwindow\.(alert|confirm|prompt)\(/, "askConfirm (lib/confirm.ts) or ConfirmButton"],
	[/(?<![.\w])(alert|prompt)\(/, "askConfirm (lib/confirm.ts) or ConfirmButton"],
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return sourceFiles(path);
		}
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

function nativeAttributeProblem(tag: string, attribute: ts.JsxAttribute): string | null {
	const name = attribute.name.getText();
	if (name === "title") {
		return `title on <${tag}>: use data-hint (or Hint)`;
	}
	const value = attribute.initializer;
	if (tag !== "input" || name !== "type" || !value || !ts.isStringLiteral(value)) {
		return null;
	}
	const picker = NATIVE_INPUT_TYPES[value.text];
	return picker ? `<input type="${value.text}">: use ${picker}` : null;
}

function nativeElementProblem(node: ts.JsxOpeningLikeElement): string | null {
	const tag = node.tagName.getText();
	if (!/^[a-z]/.test(tag)) {
		return null;
	}
	const instead = NATIVE_ELEMENTS[tag];
	if (instead) {
		return `<${tag}>: use ${instead}`;
	}
	return (
		node.attributes.properties
			.filter(ts.isJsxAttribute)
			.map((attribute) => nativeAttributeProblem(tag, attribute))
			.find((problem) => problem !== null) ?? null
	);
}

/** Every use of native UI in one file, as `file:line what`. */
export function nativeUiIn(path: string, text: string): string[] {
	const found: string[] = [];
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		for (const [pattern, instead] of NATIVE_CALLS) {
			if (pattern.test(line)) {
				found.push(`${path}:${index + 1} ${line.trim()}: use ${instead}`);
			}
		}
	});
	if (path.endsWith(".tsx")) {
		const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		const visit = (node: ts.Node) => {
			if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
				const problem = nativeElementProblem(node);
				if (problem) {
					const { line } = source.getLineAndCharacterOfPosition(node.getStart());
					found.push(`${path}:${line + 1} ${problem}`);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return found;
}

describe("nativeUiIn", () => {
	it.each([
		["a hover title", "a.tsx", '<button title="Play">x</button>'],
		["a dropdown", "a.tsx", "<select><option>a</option></select>"],
		["a suggestion list", "a.tsx", "<datalist id='x' />"],
		["a date input", "a.tsx", '<input type="date" />'],
		["a file input", "a.tsx", '<input type="file" />'],
		["the system dialog plugin", "a.ts", 'import { ask } from "@tauri-apps/plugin-dialog";'],
		["a browser confirm", "a.ts", 'if (window.confirm("Sure?")) {}'],
		["a browser alert", "a.ts", 'alert("Done");'],
	])("catches %s", (_what, path, text) => {
		expect(nativeUiIn(path, text)).not.toEqual([]);
	});

	it.each([
		["a hint", "a.tsx", '<button data-hint="Play">x</button>'],
		["a component's own title", "a.tsx", '<PageHeader title="Library" />'],
		["a text input", "a.tsx", '<input type="text" />'],
		["a method called alert", "a.ts", "notices.alert(message);"],
	])("allows %s", (_what, path, text) => {
		expect(nativeUiIn(path, text)).toEqual([]);
	});
});

describe("the app's source", () => {
	it("uses no native UI", () => {
		const found = sourceFiles(SOURCE_ROOT).flatMap((path) =>
			nativeUiIn(path.slice(SOURCE_ROOT.length), readFileSync(path, "utf8")),
		);
		expect(found).toEqual([]);
	});
});
