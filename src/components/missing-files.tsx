import { FileX, Trash2 } from "lucide-react";
import { CreditLine } from "#/components/credit-line.tsx";
import { fileMenuEntries } from "#/components/file-menu.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine, LoadingLine } from "#/components/page.tsx";
import {
	PanelActions,
	PanelIntro,
	PROBLEM_ROW,
	ProblemList,
	ProblemsCleared,
	ProblemText,
} from "#/components/problem-panel.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { PanelBarTitle } from "#/context/panel-bar.tsx";
import { timeAgo } from "#/lib/format.ts";
import { baseName } from "#/lib/fs-path.ts";
import { useLibraryStatus, useMissingTracks, useRemoveMissing } from "#/lib/queries.ts";

/** Status bar notice: files vanished from disk. Hidden when nothing is missing. */
export function MissingIndicator({ onClick }: { onClick: () => void }) {
	const missing = useLibraryStatus().data?.missing ?? 0;
	if (missing === 0) {
		return null;
	}
	return (
		<button
			type="button"
			onClick={onClick}
			data-hint={`${missing} ${missing === 1 ? "file" : "files"} missing from disk. Show them.`}
			aria-label={`${missing} missing ${missing === 1 ? "file" : "files"}`}
			className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-warning hover:bg-warning/15"
		>
			<FileX className="size-3.5" />
			{missing} missing
		</button>
	);
}

function MissingList({ count }: { count: number }) {
	const missing = useMissingTracks(true);
	if (missing.isError) {
		return <ErrorLine>{String(missing.error)}</ErrorLine>;
	}
	if (!missing.data) {
		return <LoadingLine>Reading missing files…</LoadingLine>;
	}
	const now = Date.now() / 1000;
	return (
		<ProblemList title={`${count} missing ${count === 1 ? "file" : "files"}`}>
			{missing.data.map((t) => (
				<RowMenu
					key={t.id}
					label={t.title}
					render={<li />}
					className={PROBLEM_ROW}
					items={fileMenuEntries(t.path, { onDisk: false })}
				>
					<ProblemText
						name={t.title}
						where={
							t.artist === "" && t.album === "" ? (
								baseName(t.path)
							) : (
								<CreditLine artist={t.artist} album={t.album} />
							)
						}
						hint={t.path}
						notes={[
							{
								text:
									t.removedAt <= now
										? "Removed on the next sync"
										: `Removed ${timeAgo(t.removedAt)}`,
								tone: "warning",
							},
						]}
					/>
				</RowMenu>
			))}
		</ProblemList>
	);
}

function MissingBody({ onEmpty }: { onEmpty: () => void }) {
	const status = useLibraryStatus().data;
	const remove = useRemoveMissing();
	if (!status || status.missing === 0) {
		return (
			<ProblemsCleared title="Nothing is missing">
				Every song in the library has its file on disk.
			</ProblemsCleared>
		);
	}
	return (
		<div className="space-y-4">
			<PanelIntro>
				These songs' files are gone from the library folder. They are hidden until the files come
				back, and removed from the library after {status.graceDays} days.
			</PanelIntro>
			<PanelActions>
				<ConfirmButton
					variant="outline"
					size="sm"
					disabled={remove.isPending}
					destructive
					confirmLabel={`Remove ${status.missing} missing ${status.missing === 1 ? "song" : "songs"}`}
					consequence="Removed from the library and from your sync destinations."
					onConfirm={() => remove.mutate(undefined, { onSuccess: onEmpty })}
				>
					<Trash2 />
					Remove now
				</ConfirmButton>
			</PanelActions>
			{remove.isError && <ErrorLine>{String(remove.error)}</ErrorLine>}
			<MissingList count={status.missing} />
		</div>
	);
}

/** The side panel listing the missing files, with when each goes. Closes once none are left. */
export function MissingPanel() {
	const { close } = useDetail();
	return (
		<>
			<PanelBarTitle>Missing files</PanelBarTitle>
			<MissingBody onEmpty={close} />
		</>
	);
}
