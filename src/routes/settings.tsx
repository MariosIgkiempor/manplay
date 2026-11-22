import { createFileRoute } from "@tanstack/react-router";
import { AppUpdate } from "#/components/app-update.tsx";
import { FrameHeader } from "#/components/frame.tsx";
import { LibrarySettings } from "#/components/library-settings.tsx";
import { LookupSettings } from "#/components/lookup-settings.tsx";
import { SharedLibrarySettings } from "#/components/shared-library.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
	const tracks = useTracks();
	return (
		<main>
			<FrameHeader title="Settings" />
			<div className="w-full max-w-4xl space-y-6 px-6 pt-6 pb-12">
				<LibrarySettings />
				<SharedLibrarySettings />
				<LookupSettings />
				<AppUpdate />
			</div>
			<StatusBar>
				<Stat label="Songs" value={tracks.data?.length ?? 0} />
			</StatusBar>
		</main>
	);
}
