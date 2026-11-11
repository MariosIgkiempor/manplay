import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { type ItunesStatus, itunesStatus, pickItunesFolder, setItunesPath } from "#/lib/api.ts";
import { timeAgo } from "#/lib/format.ts";
import { useItunesImport, useLibraryRoot } from "#/lib/queries.ts";

export const Route = createFileRoute("/itunes")({ component: ItunesPage });

function LastRun({ status }: { status: ItunesStatus }) {
	const last = status.last;
	if (last === null) {
		return <p className="text-muted-foreground text-sm">Not imported yet.</p>;
	}
	return (
		<div className="space-y-2 text-sm">
			{last.error && <p className="text-destructive">{last.error}</p>}
			<p className="text-muted-foreground">
				{timeAgo(last.ranAt)} · {last.converted.length} converted · {last.skipped} already in
				library · {last.failed.length} failed
			</p>
			{last.converted.length > 0 && (
				<ul className="max-h-48 space-y-0.5 overflow-y-auto">
					{last.converted.map((c) => (
						<li key={c.dest} className="truncate">
							{c.artist} — {c.title}
							<span className="text-muted-foreground"> · {c.album}</span>
						</li>
					))}
				</ul>
			)}
			{last.failed.length > 0 && (
				<ul className="space-y-0.5 text-destructive text-xs">
					{last.failed.map((f) => (
						<li key={f.file} className="break-all">
							{f.file}: {f.error}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function ItunesPage() {
	const queryClient = useQueryClient();
	const status = useQuery({ queryKey: ["itunes"], queryFn: itunesStatus });
	const root = useLibraryRoot();
	const update = (next: ItunesStatus) => queryClient.setQueryData(["itunes"], next);

	const choose = useMutation({
		mutationFn: async () => {
			const path = await pickItunesFolder();
			return path === null ? null : setItunesPath(path);
		},
		onSuccess: (next) => {
			if (next) {
				update(next);
			}
		},
	});
	const stop = useMutation({ mutationFn: () => setItunesPath(null), onSuccess: update });
	const run = useItunesImport();
	const path = status.data?.path ?? null;

	return (
		<main className="max-w-3xl space-y-6 p-6">
			<header>
				<h1 className="font-bold text-2xl">iTunes</h1>
				<p className="text-muted-foreground text-sm">
					New songs from your iTunes folder are converted to 320 kbps MP3 and filed under
					artist/album in your library. The iTunes folder is never changed. This also runs each time
					manplay starts.
				</p>
			</header>

			{status.isError && <p className="text-destructive text-sm">{String(status.error)}</p>}
			{root.data === null && (
				<p className="text-destructive text-sm">Choose your library folder first (Library page).</p>
			)}

			{status.data && (
				<section className="space-y-3 rounded-xl border bg-card p-4">
					<h2 className="font-medium">iTunes folder</h2>
					{path === null ? (
						<p className="text-muted-foreground text-sm">
							Pick the folder that holds your purchased songs, usually “iTunes Media” or “Music”
							inside your iTunes/Music folder.
						</p>
					) : (
						<p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{path}</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button
							variant={path === null ? "default" : "outline"}
							onClick={() => choose.mutate()}
							disabled={choose.isPending}
						>
							<FolderOpen /> {path === null ? "Choose folder…" : "Change folder…"}
						</Button>
						{path !== null && (
							<>
								<Button onClick={() => run.mutate()} disabled={run.isPending || root.data === null}>
									<RefreshCw className={run.isPending ? "animate-spin" : undefined} />
									{run.isPending ? "Converting…" : "Import now"}
								</Button>
								<Button variant="ghost" onClick={() => stop.mutate()} disabled={stop.isPending}>
									Stop importing
								</Button>
							</>
						)}
					</div>
					{[choose, stop, run].map(
						(m) =>
							m.isError && (
								<p key={m.submittedAt} className="text-destructive text-sm">
									{String(m.error)}
								</p>
							),
					)}
				</section>
			)}

			{status.data && path !== null && (
				<section className="space-y-2 rounded-xl border bg-card p-4">
					<h2 className="font-medium">Last import</h2>
					<LastRun status={status.data} />
				</section>
			)}
		</main>
	);
}
