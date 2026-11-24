import { useNavigate, useRouter } from "@tanstack/react-router";
import { useDetail, useDetailNav } from "#/context/detail-context.ts";
import { usePlayer } from "#/context/player-context.ts";
import { revealTrack } from "#/lib/reveal-playing.ts";
import { useShortcut } from "#/lib/use-shortcuts.ts";
import { setWaveformShown, useWaveformShown } from "#/lib/use-waveform-shown.ts";

/** How far the skip keys move the playhead. */
const SKIP_SECONDS = 10;

/** The pages the ⌘ number keys go to, in the sidebar's order. */
function usePageKeys() {
	const navigate = useNavigate();
	useShortcut("goLibrary", () => void navigate({ to: "/" }));
	useShortcut("goFiles", () => void navigate({ to: "/files" }));
	useShortcut("goMetadata", () => void navigate({ to: "/metadata" }));
	useShortcut("goImport", () => void navigate({ to: "/import" }));
	useShortcut("goExport", () => void navigate({ to: "/export" }));
	useShortcut("settings", () => void navigate({ to: "/settings" }));
	useShortcut(
		"shortcuts",
		() => void navigate({ to: "/settings", search: { section: "shortcuts" } }),
	);
}

/** Stepping through the queue and skipping within the song. */
function usePlayerKeys() {
	const player = usePlayer();
	const go = useDetailNav();
	useShortcut("playerNext", player.next);
	useShortcut("playerPrev", player.prev);
	useShortcut("seekBack", () => player.seek(Math.max(0, player.getTime() - SKIP_SECONDS)));
	useShortcut("seekForward", () =>
		player.seek(Math.min(player.duration, player.getTime() + SKIP_SECONDS)),
	);
	// The song in the list on screen when one holds it, else in the side panel.
	useShortcut("revealPlaying", () => {
		const current = player.current;
		if (current && !revealTrack(current.id)) {
			go({ kind: "song", trackId: current.id });
		}
	});
}

/**
 * App-wide keys that belong to no one page: the pages, the side panel, Settings and the shortcut list, back and
 * forward, the grid editor's switch, the queue and the playhead. Media keys reach the player
 * through the system instead (`useMediaSession`).
 */
export function AppShortcuts() {
	const router = useRouter();
	const detail = useDetail();
	const waveform = useWaveformShown();
	usePageKeys();
	usePlayerKeys();
	useShortcut("back", () => router.history.back());
	useShortcut("forward", () => router.history.forward());
	useShortcut("waveform", () => setWaveformShown(!waveform));
	// The right-hand panel shuts, and opens again on what it last showed.
	useShortcut("panel", () => {
		if (detail.view) {
			detail.close();
		} else if (detail.last) {
			detail.open(detail.last);
		}
	});
	return null;
}
