import { Monitor, Moon, Sun } from "lucide-react";
import type { ComponentType } from "react";
import { FieldRow, FrameSection } from "#/components/frame.tsx";
import type { ThemeChoice } from "#/lib/theme.ts";
import { setThemeChoice, useThemeChoice } from "#/lib/use-theme.ts";

const OPTIONS: {
	choice: ThemeChoice;
	label: string;
	icon: ComponentType<{ className?: string }>;
}[] = [
	{ choice: "light", label: "Light", icon: Sun },
	{ choice: "dark", label: "Dark", icon: Moon },
	{ choice: "system", label: "System", icon: Monitor },
];

/** Light, dark, or following the OS. Kept on this computer, not with the library. */
export function AppearanceSettings() {
	const choice = useThemeChoice();
	return (
		<FrameSection title="Appearance">
			<FieldRow
				label="Theme"
				description="System follows your computer's light or dark setting as it changes."
				align="center"
			>
				<fieldset className="inline-flex overflow-clip rounded-lg border text-sm">
					<legend className="sr-only">Theme</legend>
					{OPTIONS.map((o) => (
						<button
							key={o.choice}
							type="button"
							aria-pressed={choice === o.choice}
							onClick={() => setThemeChoice(o.choice)}
							className="flex items-center gap-1.5 border-l px-3 py-1.5 font-medium text-muted-foreground outline-none first:border-l-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 aria-pressed:bg-muted aria-pressed:text-foreground [&_svg]:size-4"
						>
							<o.icon />
							{o.label}
						</button>
					))}
				</fieldset>
			</FieldRow>
		</FrameSection>
	);
}
