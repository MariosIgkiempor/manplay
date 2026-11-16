import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import {
	type PullOutcome,
	type RemoteItem,
	remoteDownload,
	remoteMove,
	remoteUpload,
} from "#/lib/api.ts";
import type { DragSession, DropDest, DropOp, PaneSource } from "#/lib/drag-session.ts";
import { relSegments } from "#/lib/fs-path.ts";

interface Pending {
	session: DragSession;
	dest: DropDest;
	op: DropOp;
}

/** Remote paths are `/folder/file`; the backend wants the segments. */
const segments = (path: string) => relSegments("/", path);

const MAX_LISTED = 4;

function itemList(names: readonly string[]): string {
	const shown = names.slice(0, MAX_LISTED).join(", ");
	return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown;
}

function describe(op: DropOp, done: number, o: PullOutcome | null): string {
	const parts = [`${op === "move" ? "Moved" : "Copied"} ${done}`];
	if (o && o.skipped > 0) {
		parts.push(`${o.skipped} already there`);
	}
	if (o && o.failedTotal > 0) {
		parts.push(`${o.failedTotal} failed: ${o.failed.slice(0, 3).join(", ")}`);
	}
	return parts.join(" · ");
}

async function run({ session, dest, op }: Pending): Promise<{ text: string; failed: boolean }> {
	const items: RemoteItem[] = session.items.map((i) => ({
		rel: segments(i.path),
		isDir: i.isDir,
	}));
	const { source } = session;
	if (dest.source.kind === "remote" && source.kind === "remote") {
		const moved = await remoteMove(source.id, items, segments(dest.path));
		return { text: describe(op, moved, null), failed: false };
	}
	const outcome =
		dest.source.kind === "remote"
			? await remoteUpload(
					dest.source.id,
					session.items.map((i) => i.path),
					segments(dest.path),
				)
			: source.kind === "remote"
				? await remoteDownload(source.id, items, dest.path)
				: null;
	if (outcome === null) {
		return { text: "Nothing to do", failed: false };
	}
	return { text: describe(op, outcome.pulled, outcome), failed: outcome.failedTotal > 0 };
}

/**
 * Drops that touch a destination: copies between the library and a destination, and moves inside
 * one. Each asks first, since it changes files that a local undo cannot bring back.
 */
export function useTransfer(nameOf: (source: PaneSource) => string) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState<Pending | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);

	const confirm = async () => {
		if (pending === null) {
			return;
		}
		setBusy(true);
		try {
			setNotice(await run(pending));
		} catch (e) {
			setNotice({ text: String(e), failed: true });
		} finally {
			setBusy(false);
			setPending(null);
			await queryClient.invalidateQueries({
				predicate: (q) => {
					const head = q.queryKey[0];
					return (
						typeof head === "string" &&
						(head === "fs" ||
							head === "tracks" ||
							head === "library-status" ||
							head.startsWith("remote-"))
					);
				},
			});
		}
	};

	const names = pending?.session.items.map((i) => i.name) ?? [];
	const into = pending
		? (pending.dest.path.split("/").filter(Boolean).pop() ?? nameOf(pending.dest.source))
		: "";
	const verb = pending?.op === "move" ? "Move" : "Copy";
	const dialog = pending && (
		<ConfirmDialog
			title={`${verb} ${names.length} ${names.length === 1 ? "item" : "items"} to “${into}”?`}
			confirmLabel={verb}
			busy={busy}
			onCancel={() => setPending(null)}
			onConfirm={() => void confirm()}
		>
			<p className="break-words">{itemList(names)}</p>
			<p className="mt-2 text-xs">
				{pending.op === "move"
					? `Moves them on ${nameOf(pending.dest.source)}. This can’t be undone here.`
					: `From ${nameOf(pending.session.source)} to ${nameOf(pending.dest.source)}. Files already there are skipped.`}
			</p>
		</ConfirmDialog>
	);

	return {
		onTransfer: (session: DragSession, dest: DropDest, op: DropOp) =>
			setPending({ session, dest, op }),
		dialog,
		notice,
		dismiss: () => setNotice(null),
	};
}
