import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { answerConfirm, usePendingConfirm } from "#/lib/confirm.ts";

/** Shows the question `askConfirm` is asking. Mounted once, in the shell. */
export function ConfirmHost() {
	const question = usePendingConfirm();
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
