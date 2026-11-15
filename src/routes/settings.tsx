import { createFileRoute } from "@tanstack/react-router";
import { AppUpdate } from "#/components/app-update.tsx";
import { LibrarySettings } from "#/components/library-settings.tsx";
import { Page } from "#/components/page.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
	const tracks = useTracks();
	return (
		<Page title="Settings">
			<LibrarySettings />
			<AppUpdate />
			<StatusBar>
				<Stat label="Songs" value={tracks.data?.length ?? 0} />
			</StatusBar>
		</Page>
	);
}
