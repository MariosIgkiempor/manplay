import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, FileDown, FolderOpen } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
	exportRekordbox,
	pickRekordboxFile,
	type RekordboxStatus,
	setRekordboxPath,
} from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";

function Status({ status }: { status: RekordboxStatus }) {
	if (status.error) {
		return <p className="text-destructive text-sm">{status.error}</p>;
	}
	if (status.exportedAt === null) {
		return <p className="text-muted-foreground text-sm">Not exported yet.</p>;
	}
	return (
		<p className="text-muted-foreground text-sm">
			Updated {timeAgo(status.exportedAt)} · {status.playlists}{" "}
			{status.playlists === 1 ? "playlist" : "playlists"} · {status.tracks} tracks
		</p>
	);
}

export function RekordboxExport({ status }: { status: RekordboxStatus }) {
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);
	const update = (next: RekordboxStatus) => queryClient.setQueryData(["rekordbox"], next);

	const choose = useMutation({
		mutationFn: async () => {
			const path = await pickRekordboxFile();
			return path === null ? null : setRekordboxPath(path);
		},
		onSuccess: (next) => {
			if (next) {
				update(next);
			}
		},
	});
	const exportNow = useMutation({ mutationFn: exportRekordbox, onSuccess: update });
	const stop = useMutation({ mutationFn: () => setRekordboxPath(null), onSuccess: update });

	const copy = async () => {
		if (status.path === null) {
			return;
		}
		try {
			await navigator.clipboard.writeText(status.path);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard access can be denied; the path is also visible on screen.
		}
	};

	return (
		<section className="space-y-3 rounded-xl border bg-card p-4">
			<h2 className="font-medium">Export file</h2>
			{status.path === null ? (
				<p className="text-muted-foreground text-sm">
					Choose where manplay should save a rekordbox library file. It is kept up to date
					automatically after that.
				</p>
			) : (
				<>
					<p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{status.path}</p>
					<Status status={status} />
				</>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					variant={status.path === null ? "default" : "outline"}
					onClick={() => choose.mutate()}
					disabled={choose.isPending}
				>
					<FolderOpen /> {status.path === null ? "Choose location…" : "Change location…"}
				</Button>
				{status.path !== null && (
					<>
						<Button onClick={() => exportNow.mutate()} disabled={exportNow.isPending}>
							<FileDown /> Export now
						</Button>
						<Button variant="outline" onClick={() => void copy()}>
							<Copy /> {copied ? "Copied" : "Copy path"}
						</Button>
						<Button variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>
							Stop exporting
						</Button>
					</>
				)}
			</div>
			{[choose, exportNow, stop].map(
				(m) =>
					m.isError && (
						<p key={m.submittedAt} className="text-destructive text-sm">
							{String(m.error)}
						</p>
					),
			)}
		</section>
	);
}
