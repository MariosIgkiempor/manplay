import { useEffect } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { trackActionAnchors } from "#/lib/action-anchor.ts";
import { answerConfirm, usePendingConfirm } from "#/lib/confirm.ts";

/**
 * Shows the question `askConfirm` is asking, and notes where the user acts so every question
 * opens beside its action. Mounted once, in the shell.
 */
export function ConfirmHost() {
	const question = usePendingConfirm();
	useEffect(() => trackActionAnchors(), []);
	return (
		question && (
			<ConfirmDialog
				title={question.title}
				confirmLabel={question.confirmLabel}
				destructive={question.destructive ?? false}
				onCancel={() => answerConfirm(false)}
				onConfirm={() => answerConfirm(true)}
			>
				{question.lines && question.lines.length > 0 && (
					<span className="whitespace-pre-line">{question.lines.join("\n")}</span>
				)}
			</ConfirmDialog>
		)
	);
}
