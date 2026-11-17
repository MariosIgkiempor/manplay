import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { AppUpdate } from "#/components/app-update.tsx";
import { DeviceSettings } from "#/components/device-settings.tsx";
import { LibrarySettings } from "#/components/library-settings.tsx";
import { Page } from "#/components/page.tsx";
import { SharedLibrarySettings } from "#/components/shared-library.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { useTracks } from "#/lib/queries.ts";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
	const tracks = useTracks();
	return (
		<Page title="Settings" icon={<Settings />}>
			<LibrarySettings />
			<SharedLibrarySettings />
			<DeviceSettings />
			<AppUpdate />
			<StatusBar>
				<Stat label="Songs" value={tracks.data?.length ?? 0} />
			</StatusBar>
		</Page>
	);
}
