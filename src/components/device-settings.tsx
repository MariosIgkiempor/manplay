import { useEffect, useState } from "react";
import { ErrorLine, Panel, Section } from "#/components/page.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useDeviceName } from "#/lib/queries.ts";

/** The name other members of a shared library see this device as. */
export function DeviceSettings() {
	const { name, save } = useDeviceName();
	const [draft, setDraft] = useState("");
	useEffect(() => {
		if (name.data !== undefined) {
			setDraft(name.data);
		}
	}, [name.data]);
	const commit = () => {
		if (name.data !== undefined && draft.trim() !== name.data) {
			save.mutate(draft, { onSuccess: setDraft });
		}
	};
	return (
		<Section title="This device">
			<Panel className="space-y-2">
				<p className="font-medium text-sm">Device name</p>
				<Input
					aria-label="Device name"
					value={draft}
					disabled={name.data === undefined}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
				/>
				<p className="text-muted-foreground text-xs">
					Shown to the other members of a shared library. Leave it empty to use this computer's
					name.
				</p>
				{save.isError && <ErrorLine>{String(save.error)}</ErrorLine>}
			</Panel>
		</Section>
	);
}
