import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AudioWaveform, Globe, Info, Keyboard, Library, Palette } from "lucide-react";
import { AnalysisSettings } from "#/components/analysis-settings.tsx";
import { AppUpdate } from "#/components/app-update.tsx";
import { AppearanceSettings } from "#/components/appearance-settings.tsx";
import { LibrarySettings } from "#/components/library-settings.tsx";
import { LookupSettings } from "#/components/lookup-settings.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { SharedLibrarySettings } from "#/components/shared-library.tsx";
import { ShortcutSettings } from "#/components/shortcut-settings.tsx";
import { Stat, StatusBar } from "#/components/status-bar.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { PAGE_BODY } from "#/lib/page-layout.ts";
import { useTracks } from "#/lib/queries.ts";
import { parseSettingsSection, type SettingsSection } from "#/lib/settings-sections.ts";
import { cn } from "#/lib/utils.ts";

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
	{ value: "analysis", label: "BPM & key", icon: <AudioWaveform /> },
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
			<PageHeader
				title="Settings"
				tabs={
					<Segmented
						ruled={false}
						value={section}
						onChange={(next) => void navigate({ search: { section: next }, replace: true })}
						label="Settings section"
						items={TABS}
						compact
					/>
				}
			/>
			<div className={cn("w-full max-w-5xl space-y-8", PAGE_BODY)}>
				{section === "library" && (
					<>
						<LibrarySettings />
						<SharedLibrarySettings />
					</>
				)}
				{section === "analysis" && <AnalysisSettings />}
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
