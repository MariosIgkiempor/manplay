import { createFileRoute } from "@tanstack/react-router";
import { AppUpdate } from "#/components/app-update.tsx";
import { LibrarySettings } from "#/components/library-settings.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";

import { useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
	const tracks = useTracks();
	return (
		<main className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
			<h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
			<LibrarySettings />
			<AppUpdate />
			<StatusBar>
				<Stat label="Songs" value={tracks.data?.length ?? 0} />
			</StatusBar>
		</main>
	);
}
