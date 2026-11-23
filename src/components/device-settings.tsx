import { useEffect, useId, useState } from "react";
import { FieldRow } from "#/components/frame.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { MoreInfo } from "#/components/ui/facts.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useDeviceName } from "#/lib/queries.ts";

/** The name other members of a shared library see this device as, saved when the field is left. */
export function DeviceNameRow() {
	const { name, save } = useDeviceName();
	const [draft, setDraft] = useState("");
	const inputId = useId();
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
		<FieldRow
			label="Device name"
			htmlFor={inputId}
			description={
				<>
					Your name to other members{" "}
					<MoreInfo hint="How other members see this computer. Empty uses the computer's name." />
				</>
			}
		>
			<Input
				id={inputId}
				value={draft}
				disabled={name.data === undefined}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
			/>
			{save.isError && <ErrorLine compact>{String(save.error)}</ErrorLine>}
		</FieldRow>
	);
}
