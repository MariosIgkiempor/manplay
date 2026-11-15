import type { SaveStatus } from "#/lib/unsaved.tsx";

/** "Saving…", "Saved", "Not saved: …" for an autosaving form. */
export function SaveState({
	status,
	error,
	invalid = "Not saved",
}: {
	status: SaveStatus;
	error: string | null;
	/** Shown while the changes cannot be saved as they are. */
	invalid?: string;
}) {
	const text: Record<SaveStatus, string> = {
		saved: "Saved",
		pending: "Saving…",
		saving: "Saving…",
		error: `Not saved: ${error ?? ""}`,
		invalid,
	};
	return (
		<output
			className={
				status === "error" || status === "invalid"
					? "text-destructive text-xs"
					: "text-muted-foreground text-xs"
			}
		>
			{text[status]}
		</output>
	);
}
