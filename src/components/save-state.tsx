import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SaveSlotContext } from "#/context/status-context.ts";
import type { SaveStatus } from "#/lib/unsaved.tsx";
import { cn } from "#/lib/utils.ts";

/** How long "Saved" stays in the status bar. */
const SAVED_FOR = 3000;

/**
 * Whether an autosaving form's changes are saved, shown in the status bar: "Saving…" while it
 * writes, "Saved" for a few seconds after, and failures until fixed. Why the changes cannot be
 * saved yet (`invalid`) stays beside the form.
 */
export function SaveState({
	status,
	error,
	invalid = "Not saved",
}: {
	status: SaveStatus;
	error: string | null;
	/** Shown beside the form while the changes cannot be saved as they are. */
	invalid?: string;
}) {
	const slot = useContext(SaveSlotContext);
	const [justSaved, setJustSaved] = useState(false);
	const last = useRef(status);
	useEffect(() => {
		const was = last.current;
		last.current = status;
		if (status === "saved" && (was === "saving" || was === "pending")) {
			setJustSaved(true);
			const timer = setTimeout(() => setJustSaved(false), SAVED_FOR);
			return () => clearTimeout(timer);
		}
		if (status !== "saved") {
			setJustSaved(false);
		}
		return undefined;
	}, [status]);

	if (status === "invalid") {
		return <output className="text-destructive text-xs">{invalid}</output>;
	}
	let body: { icon: React.ReactNode; text: string; error?: boolean } | null = null;
	if (status === "pending" || status === "saving") {
		body = { icon: <LoaderCircle className="animate-spin" />, text: "Saving…" };
	} else if (status === "error") {
		body = { icon: <CircleAlert />, text: `Not saved: ${error ?? ""}`, error: true };
	} else if (justSaved) {
		body = { icon: <Check />, text: "Saved" };
	}
	if (!body) {
		return null;
	}
	const out = (
		<output
			data-hint={body.text}
			className={cn(
				"flex min-w-0 items-center gap-1.5 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0",
				body.error ? "text-destructive" : "text-muted-foreground",
			)}
		>
			{body.icon}
			<span className="truncate">{body.text}</span>
		</output>
	);
	return slot ? createPortal(out, slot) : out;
}
