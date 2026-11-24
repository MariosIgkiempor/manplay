// Runs manplay's frontend in a headless browser against a fake backend, and drives it from the
// command line: open a page, click, type, read the page as text, take a screenshot. For agents
// that need to see the app without the desktop. See docs/harness.md.
//
// `start` leaves one background process holding the dev server, the browser and the open page;
// every other command is a request to it, so the page keeps its state between commands.

import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK_DIR = join(ROOT, "node_modules", ".cache", "manplay-harness");
const STATE_FILE = join(WORK_DIR, "state.json");
const LOG_FILE = join(WORK_DIR, "daemon.log");
const SHOTS_DIR = join(WORK_DIR, "shots");
const SETTLE_MS = 2000;
const ACTION_TIMEOUT_MS = 8000;
/** The first page is built from cold, which in a fresh checkout takes longer than any later step. */
const FIRST_LOAD_TIMEOUT_MS = 60_000;
const WINDOWS_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

/** One page of each kind, for `tour`. Ids are those of the fake backend's `full` scenario. */
const TOUR = [
	["library", "/"],
	["files", "/files"],
	["metadata", "/metadata"],
	["playlist", "/playlists/1"],
	["smart-playlist", "/smart/2"],
	["tag", "/tags/Genre/House"],
	["import", "/import"],
	["import-downloads", "/import/1"],
	["import-itunes", "/import/2"],
	["export", "/export"],
	["export-add", "/export/add"],
	["export-sync-folder", "/export/1"],
	["export-r2", "/export/2"],
	["export-rekordbox", "/export/rekordbox"],
	["export-usb", "/export/usb?mount=%2FVolumes%2FDJ%20STICK"],
	["deleted", "/deleted"],
	["settings", "/settings"],
];

const USAGE = `manplay harness: the app in a headless browser, on a fake backend.

  pnpm harness start [--platform mac|windows] [--width 1280] [--height 820] [--scale 1]
  pnpm harness stop | status

  pnpm harness goto <path>                 open a route, e.g. /settings
  pnpm harness text [selector]             the page (or one part) as an accessibility tree
  pnpm harness shot [name] [--selector s] [--full]   save a PNG, print its path
  pnpm harness click <selector> [--right] [--double]
  pnpm harness hover <selector>
  pnpm harness fill <selector> <text>
  pnpm harness press <key>                 e.g. Escape, Meta+k, ArrowDown
  pnpm harness type <text>
  pnpm harness scroll <selector> <pixels>  scrolls it, or the scrolling area it is in
  pnpm harness tour [folder]               a screenshot of every kind of page
  pnpm harness wait <selector | milliseconds>
  pnpm harness eval <javascript>           runs in the page, prints the result as JSON
  pnpm harness errors                      console errors and commands the fake backend lacks
  pnpm harness resize <width> <height>
  pnpm harness scenario <full|empty|large> restart the app from another set of data
  pnpm harness emit <event> <json>         send a backend event, e.g. sync-progress

Selectors are Playwright's: text=Settings, role=button[name="Sync"], or CSS.
`;

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return null;
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function runningState() {
	const state = readState();
	return state && isAlive(state.pid) ? state : null;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- the background process ------------------------------------------------

/** A console message as the browser's console shows it: the values put into its `%s` places. */
async function consoleText(message) {
	const values = await Promise.all(
		message.args().map((arg) => arg.jsonValue().catch(() => String(arg))),
	);
	const [format, ...rest] = values;
	// Only a printf-style message needs putting together; the browser's own text does for the rest.
	if (typeof format !== "string" || !format.includes("%")) {
		return message.text();
	}
	const shown = rest.map((value) => (typeof value === "string" ? value : JSON.stringify(value)));
	const filled = format.replaceAll(/%[sdoO]/g, () => shown.shift() ?? "");
	return [filled, ...shown].join(" ");
}

/** Console errors and uncaught errors seen since they were last reported. */
function collectProblems(page) {
	const problems = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			void consoleText(message).then((text) => problems.push(`console: ${text}`));
		}
	});
	page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
	return {
		take: async () => {
			const unhandled = await page
				.evaluate(() => globalThis.__harness?.unhandled.splice(0) ?? [])
				.catch(() => []);
			const fresh = [...problems.splice(0), ...unhandled.map((c) => `no fake for command: ${c}`)];
			return [...new Set(fresh)];
		},
	};
}

async function settle(page) {
	await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
	await page.evaluate(() => document.fonts.ready).catch(() => undefined);
}

function shotPath(name) {
	if (name && (isAbsolute(name) || name.includes("/"))) {
		return resolve(name);
	}
	const file = name ? name.replace(/\.png$/, "") : `shot-${Date.now()}`;
	return join(SHOTS_DIR, `${file}.png`);
}

/** Scrolls the element, or the closest thing around it that scrolls. Runs in the page. */
function scrollNearest(node, top) {
	let scroller = node;
	while (scroller.parentElement && scroller.scrollHeight <= scroller.clientHeight) {
		scroller = scroller.parentElement;
	}
	scroller.scrollBy({ top });
}

function actions(page, baseUrl) {
	const find = (selector) => page.locator(selector).first();
	return {
		goto: async ([path = "/"]) => {
			await page.goto(new URL(path, baseUrl).href, { waitUntil: "load" });
			return `at ${new URL(page.url()).pathname}`;
		},
		text: ([selector = "body"]) => find(selector).ariaSnapshot(),
		shot: async ([name], flags) => {
			const path = shotPath(name);
			mkdirSync(dirname(path), { recursive: true });
			const options = { path, animations: "disabled" };
			await (flags.selector
				? find(flags.selector).screenshot(options)
				: page.screenshot({ ...options, fullPage: flags.full === true }));
			return path;
		},
		click: async ([selector], flags) => {
			await find(selector).click({
				button: flags.right ? "right" : "left",
				clickCount: flags.double ? 2 : 1,
			});
			return `clicked ${selector}`;
		},
		hover: async ([selector]) => {
			await find(selector).hover();
			return `hovering ${selector}`;
		},
		fill: async ([selector, value = ""]) => {
			await find(selector).fill(value);
			return `filled ${selector}`;
		},
		press: async ([key]) => {
			await page.keyboard.press(key);
			return `pressed ${key}`;
		},
		type: async ([value]) => {
			await page.keyboard.type(value);
			return `typed ${value}`;
		},
		scroll: async ([selector, pixels = "400"]) => {
			await find(selector).evaluate(scrollNearest, Number(pixels));
			return `scrolled ${selector}`;
		},
		tour: async ([folder = "tour"]) => {
			const lines = [];
			for (const [name, path] of TOUR) {
				await page.goto(new URL(path, baseUrl).href, { waitUntil: "load" });
				await settle(page);
				const file = join(SHOTS_DIR, folder, `${name}.png`);
				mkdirSync(dirname(file), { recursive: true });
				await page.screenshot({ path: file, animations: "disabled" });
				lines.push(`${path}  ->  ${file}`);
			}
			return lines.join("\n");
		},
		wait: async ([target]) => {
			await (/^\d+$/.test(target) ? sleep(Number(target)) : find(target).waitFor());
			return `waited for ${target}`;
		},
		eval: async ([source]) => JSON.stringify(await page.evaluate(source), null, 2) ?? "undefined",
		errors: () => "",
		resize: async ([width, height]) => {
			await page.setViewportSize({ width: Number(width), height: Number(height) });
			return `viewport ${width}x${height}`;
		},
		scenario: async ([name]) => {
			await page.evaluate((next) => globalThis.__harness.setScenario(next), name);
			await page.waitForLoadState("load");
			return `scenario ${name}`;
		},
		emit: async ([event, json = "null"]) => {
			await page.evaluate(
				([name, payload]) => globalThis.__harness.emit(name, payload),
				[event, JSON.parse(json)],
			);
			return `emitted ${event}`;
		},
	};
}

function readBody(request) {
	return new Promise((done, fail) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => done(body));
		request.on("error", fail);
	});
}

async function answer(request, handlers, problems, page) {
	const { command, args, flags } = JSON.parse(await readBody(request));
	const handler = handlers[command];
	if (!handler) {
		return { ok: false, output: `unknown command "${command}"`, problems: [] };
	}
	try {
		const output = await handler(args, flags);
		await settle(page);
		return { ok: true, output, problems: await problems.take() };
	} catch (error) {
		return { ok: false, output: String(error?.message ?? error), problems: await problems.take() };
	}
}

async function runDaemon(options) {
	const { createServer } = await import("vite");
	const { chromium, webkit } = await import("playwright");
	// Another checkout's harness may hold 3210; then the next free port is used.
	const vite = await createServer({
		root: ROOT,
		mode: "harness",
		server: { port: 3210, strictPort: false },
	});
	await vite.listen();
	const baseUrl = vite.resolvedUrls?.local[0] ?? "http://localhost:3210/";

	// The app's webview is WebKit on macOS and Chromium (WebView2) on Windows.
	const windows = options.platform === "windows";
	const browser = await (windows ? chromium : webkit).launch();
	const context = await browser.newContext({
		viewport: { width: options.width, height: options.height },
		deviceScaleFactor: options.scale,
		reducedMotion: "reduce",
		...(windows ? { userAgent: WINDOWS_USER_AGENT } : {}),
	});
	context.setDefaultTimeout(ACTION_TIMEOUT_MS);
	const page = await context.newPage();
	const problems = collectProblems(page);
	await page.goto(baseUrl, { waitUntil: "load", timeout: FIRST_LOAD_TIMEOUT_MS });
	await settle(page);

	const handlers = actions(page, baseUrl);
	const stop = async () => {
		rmSync(STATE_FILE, { force: true });
		await browser.close();
		await vite.close();
		process.exit(0);
	};
	const control = createHttpServer((request, response) => {
		const reply = (body) => response.end(JSON.stringify(body));
		if (request.url === "/stop") {
			reply({ ok: true, output: "stopped", problems: [] });
			return void stop();
		}
		return void answer(request, handlers, problems, page).then(reply);
	});
	control.listen(0, "127.0.0.1", () => {
		const state = {
			pid: process.pid,
			controlPort: control.address().port,
			url: baseUrl,
			...options,
		};
		writeFileSync(STATE_FILE, JSON.stringify(state, null, "\t"));
	});
	process.on("SIGTERM", () => void stop());
}

// ---- the command line ------------------------------------------------------

function print(line) {
	process.stdout.write(`${line}\n`);
}

async function start(flags) {
	if (runningState()) {
		print("harness is already running (pnpm harness stop to end it)");
		return;
	}
	mkdirSync(WORK_DIR, { recursive: true });
	rmSync(STATE_FILE, { force: true });
	const log = openSync(LOG_FILE, "w");
	const options = JSON.stringify({
		platform: flags.platform ?? "mac",
		width: Number(flags.width ?? 1280),
		height: Number(flags.height ?? 820),
		scale: Number(flags.scale ?? 1),
	});
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon", options], {
		cwd: ROOT,
		detached: true,
		stdio: ["ignore", log, log],
	});
	child.unref();
	for (let attempt = 0; attempt < 120; attempt += 1) {
		await sleep(500);
		const state = readState();
		if (state) {
			print(`harness running: ${state.url} (${state.platform}, ${state.width}x${state.height})`);
			return;
		}
		if (!isAlive(child.pid)) {
			break;
		}
	}
	print(`harness did not start. The end of ${LOG_FILE}:`);
	print(readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-12).join("\n"));
	print("If a browser is missing: pnpm exec playwright install webkit chromium");
	process.exitCode = 1;
}

async function send(command, args, flags) {
	const state = runningState();
	if (!state) {
		print("harness is not running: pnpm harness start");
		process.exitCode = 1;
		return;
	}
	const response = await fetch(
		`http://127.0.0.1:${state.controlPort}/${command === "stop" ? "stop" : ""}`,
		{
			method: "POST",
			body: JSON.stringify({ command, args, flags }),
		},
	);
	const { ok, output, problems } = await response.json();
	if (output) {
		print(output);
	}
	if (problems.length > 0) {
		print(`\n${problems.length} problem(s) since the last command:`);
		for (const problem of problems) {
			print(`  ${problem}`);
		}
	}
	if (!ok) {
		process.exitCode = 1;
	}
}

function main() {
	const { positionals, values: flags } = parseArgs({
		allowPositionals: true,
		options: {
			platform: { type: "string" },
			width: { type: "string" },
			height: { type: "string" },
			scale: { type: "string" },
			selector: { type: "string" },
			full: { type: "boolean" },
			right: { type: "boolean" },
			double: { type: "boolean" },
		},
	});
	const [command, ...args] = positionals;
	if (command === "daemon") {
		return runDaemon(JSON.parse(args[0]));
	}
	if (command === "start") {
		return start(flags);
	}
	if (command === "status") {
		const state = runningState();
		return print(state ? `running: ${state.url} (${state.platform})` : "not running");
	}
	if (!command || command === "help") {
		return print(USAGE);
	}
	return send(command, args, flags);
}

await main();
