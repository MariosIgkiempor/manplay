import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Globe, Info, Keyboard, Library, Palette } from "lucide-react";
import { AppUpdate } from "#/components/app-update.tsx";
import { AppearanceSettings } from "#/components/appearance-settings.tsx";
import { FrameHeader } from "#/components/frame.tsx";
import { LibrarySettings } from "#/components/library-settings.tsx";
import { LookupSettings } from "#/components/lookup-settings.tsx";
import { SharedLibrarySettings } from "#/components/shared-library.tsx";
import { ShortcutSettings } from "#/components/shortcut-settings.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { useTracks } from "#/lib/queries.ts";
import { parseSettingsSection, type SettingsSection } from "#/lib/settings-sections.ts";

export const Route = createFileRoute("/settings")({
	// `?section=shortcuts` opens that tab; anything else opens Library.
	validateSearch: (search: { section?: unknown }): { section?: SettingsSection } => {
		const section = parseSettingsSection(search.section);
		return section ? { section } : {};
	},
	component: SettingsPage,
});

const TABS = [
	{ value: "library", label: "Library", icon: <Library /> },
	{ value: "lookup", label: "Tag lookup", icon: <Globe /> },
	{ value: "appearance", label: "Appearance", icon: <Palette /> },
	{ value: "shortcuts", label: "Shortcuts", icon: <Keyboard /> },
	{ value: "about", label: "About", icon: <Info /> },
] as const satisfies readonly { value: SettingsSection; label: string; icon: React.ReactNode }[];

function SettingsPage() {
	const tracks = useTracks();
	const section = Route.useSearch().section ?? "library";
	const navigate = useNavigate({ from: "/settings" });
	return (
		<main>
			<FrameHeader
				title="Settings"
				tabs={
					<Segmented
						className="border-b-0"
						value={section}
						onChange={(next) => void navigate({ search: { section: next }, replace: true })}
						label="Settings section"
						items={TABS}
						compact
					/>
				}
			/>
			<div className="w-full max-w-4xl space-y-6 px-6 pt-6 pb-12">
				{section === "library" && (
					<>
						<LibrarySettings />
						<SharedLibrarySettings />
					</>
				)}
				{section === "lookup" && <LookupSettings />}
				{section === "appearance" && <AppearanceSettings />}
				{section === "shortcuts" && <ShortcutSettings />}
				{section === "about" && <AppUpdate />}
			</div>
			<StatusBar>
				<Stat label="Songs" value={tracks.data?.length ?? 0} />
			</StatusBar>
		</main>
	);
}
