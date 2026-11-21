import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createFakeBackend, type FakeBackend, SCENARIOS, type Scenario } from "./fake-backend.ts";
import { hashText, LIBRARY_ROOT } from "./fake-library.ts";

/**
 * Puts the fake backend where Tauri's would be, so the app runs in a plain browser. Loaded only
 * by `vite --mode harness` (see `src/client.tsx` and `docs/harness.md`).
 */

const SCENARIO_KEY = "manplay-harness-scenario";

/** What a driver reads and calls from outside the page, as `window.__harness`. */
export interface HarnessHandle {
	scenario: Scenario;
	/** Commands the app called that the fake backend has no answer for. */
	unhandled: string[];
	/** Every command called, oldest first. */
	calls: string[];
	/** Sends a backend event (e.g. `sync-progress`) to the app. */
	emit: (event: string, payload: unknown) => Promise<void>;
	/** Starts the app again from another scenario. */
	setScenario: (scenario: Scenario) => void;
}

interface HarnessWindow {
	__harness?: HarnessHandle;
	__TAURI_INTERNALS__?: { convertFileSrc?: (path: string, protocol?: string) => string };
}

function readScenario(): Scenario {
	const stored = window.sessionStorage.getItem(SCENARIO_KEY);
	return SCENARIOS.find((scenario) => scenario === stored) ?? "full";
}

/** A cover drawn from a name: the same album always gets the same colours. */
function coverUrl(name: string): string {
	const hash = hashText(name);
	const hue = hash % 360;
	const second = (hue + 40 + ((hash >>> 9) % 80)) % 360;
	const radius = 18 + ((hash >>> 17) % 22);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
		`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
		`<stop offset="0" stop-color="hsl(${hue} 55% 42%)"/>` +
		`<stop offset="1" stop-color="hsl(${second} 60% 22%)"/></linearGradient></defs>` +
		`<rect width="100" height="100" fill="url(#g)"/>` +
		`<circle cx="${30 + ((hash >>> 5) % 40)}" cy="${30 + ((hash >>> 13) % 40)}" r="${radius}" ` +
		`fill="hsl(${second} 70% 70% / 0.35)"/></svg>`;
	// The app appends `?v=…`; after the `#` that is a fragment, not part of the picture.
	return `data:image/svg+xml,${encodeURIComponent(svg)}#`;
}

/** The album folder a cover belongs to: of a song by id, or of a file or folder by path. */
function albumOf(backend: FakeBackend, source: string): string | null {
	const track = /^\d+$/.test(source)
		? backend.trackById(Number(source))
		: backend.trackByPath(source);
	if (track) {
		return `${track.artist}/${track.album}`;
	}
	return source.startsWith(LIBRARY_ROOT) ? source.slice(LIBRARY_ROOT.length + 1) : null;
}

const silence = new Map<number, string>();

/** A silent WAV of the given length, so the player runs its clock without real audio. */
function silentAudioUrl(seconds: number): string {
	const known = silence.get(seconds);
	if (known !== undefined) {
		return known;
	}
	const sampleRate = 8000;
	const samples = seconds * sampleRate;
	const bytes = new Uint8Array(44 + samples).fill(128, 44);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index += 1) {
			view.setUint8(offset + index, value.charCodeAt(index));
		}
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples, true);
	ascii(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate, true);
	view.setUint16(32, 1, true);
	view.setUint16(34, 8, true);
	ascii(36, "data");
	view.setUint32(40, samples, true);
	const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
	silence.set(seconds, url);
	return url;
}

function fileUrl(backend: FakeBackend, path: string, protocol: string): string {
	if (protocol === "lookup-cover") {
		// A looked-up release's cover, drawn from its id.
		return coverUrl(path);
	}
	if (protocol === "art") {
		const album = albumOf(backend, path);
		// One album in nine has no cover, so the placeholder is on screen too.
		return album === null || hashText(album) % 9 === 0 ? "harness-no-art:" : coverUrl(album);
	}
	const track = backend.trackByPath(path);
	return silentAudioUrl(Math.round((track?.durationMs ?? 200_000) / 1000));
}

export function installFakeBackend(): void {
	const scenario = readScenario();
	const backend = createFakeBackend(scenario);
	const handle: HarnessHandle = {
		scenario,
		unhandled: [],
		calls: [],
		emit: (event, payload) => emit(event, payload),
		setScenario: (next) => {
			window.sessionStorage.setItem(SCENARIO_KEY, next);
			window.location.reload();
		},
	};
	mockWindows("main");
	mockIPC(
		(command, args) => {
			handle.calls.push(command);
			const payload = typeof args === "object" && !ArrayBuffer.isView(args) ? args : {};
			const answer = backend.run(command, payload as Record<string, unknown>);
			if (!answer.handled) {
				handle.unhandled.push(command);
				throw new Error(`harness: the fake backend has no answer for "${command}"`);
			}
			return answer.result;
		},
		{ shouldMockEvents: true },
	);
	const harnessWindow = window as HarnessWindow;
	harnessWindow.__harness = handle;
	if (harnessWindow.__TAURI_INTERNALS__) {
		harnessWindow.__TAURI_INTERNALS__.convertFileSrc = (path, protocol = "asset") =>
			fileUrl(backend, path, protocol);
	}
}
