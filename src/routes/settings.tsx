import { createFileRoute } from "@tanstack/react-router";
import { LibrarySettings } from "#/components/library-settings.tsx";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
	return (
		<main className="max-w-3xl space-y-6 p-6">
			<h1 className="font-bold text-2xl">Settings</h1>
			<LibrarySettings />
		</main>
	);
}
