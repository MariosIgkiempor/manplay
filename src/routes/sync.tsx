import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { FolderBrowser } from "#/components/folder-browser.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	getSyncTarget,
	onSyncProgress,
	type SyncProgress,
	setSyncTarget,
	syncNow,
	tailscaleStatus,
} from "#/lib/api.ts";

export const Route = createFileRoute("/sync")({ component: SyncPage });

function SyncPage() {
	const queryClient = useQueryClient();
	const [machine, setMachine] = useState<string | null>(null);
	const [path, setPath] = useState<string[]>([]);
	const [progress, setProgress] = useState<SyncProgress | null>(null);

	const status = useQuery({ queryKey: ["ts-status"], queryFn: tailscaleStatus });
	const target = useQuery({ queryKey: ["sync-target"], queryFn: getSyncTarget });
	const tailnet = status.data?.tailnet;

	const save = useMutation({
		mutationFn: setSyncTarget,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sync-target"] }),
	});
	const sync = useMutation({ mutationFn: syncNow });

	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void onSyncProgress(setProgress).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlisten = fn;
			}
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	const pick = () => {
		if (tailnet !== undefined && machine !== null && path.length > 0) {
			save.mutate({ tailnet, machine, path });
		}
	};
	const choose = (name: string) => {
		setMachine(name);
		setPath([]);
	};

	const syncing = sync.isPending;
	const t = target.data;

	return (
		<main className="space-y-6 p-6">
			<h1 className="font-semibold text-xl">Sync</h1>

			<section className="space-y-2 rounded-lg border p-4">
				<h2 className="font-medium">Target</h2>
				{t ? (
					<>
						<p className="text-sm">
							{t.machine} / {t.path.join(" / ")}
							<span className="text-muted-foreground">
								{" "}
								— new and changed files are copied here (nothing is deleted)
							</span>
						</p>
						<div className="flex gap-2">
							<Button onClick={() => sync.mutate()} disabled={syncing}>
								{syncing ? "Syncing…" : "Sync now"}
							</Button>
							<Button variant="outline" onClick={() => save.mutate(null)} disabled={syncing}>
								Clear
							</Button>
						</div>
					</>
				) : (
					<p className="text-muted-foreground text-sm">None. Pick a machine and folder below.</p>
				)}
				{syncing && progress && progress.total > 0 && (
					<p className="text-sm">
						{progress.done} / {progress.total} {progress.current}
					</p>
				)}
				{sync.data && (
					<p className="text-sm">
						Uploaded {sync.data.uploaded}, already there {sync.data.skipped}, failed{" "}
						{sync.data.failed.length}
					</p>
				)}
				{sync.data?.failed.map((f) => (
					<p key={f} className="text-destructive text-xs">
						{f}
					</p>
				))}
				{[sync, save].map(
					(m) =>
						m.isError && (
							<p key={m.submittedAt} className="text-destructive text-sm">
								{String(m.error)}
							</p>
						),
				)}
			</section>

			<section className="space-y-2">
				<div className="flex items-center justify-between">
					<h2 className="font-medium">Machines {tailnet && `(${tailnet})`}</h2>
					<Button variant="outline" size="sm" onClick={() => void status.refetch()}>
						Refresh
					</Button>
				</div>
				{status.isError && <p className="text-destructive text-sm">{String(status.error)}</p>}
				<ul className="grid gap-1 sm:grid-cols-2">
					{status.data?.machines.map((m) => (
						<li key={m.name}>
							<button
								type="button"
								onClick={() => choose(m.name)}
								className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted ${machine === m.name ? "bg-muted" : ""}`}
							>
								<span className="truncate">
									{m.hostName}
									{m.isSelf && " (this machine)"}
								</span>
								<span className={m.online ? "text-green-500" : "text-muted-foreground"}>
									{m.online ? "online" : "offline"} · {m.os}
								</span>
							</button>
						</li>
					))}
				</ul>
			</section>

			{tailnet !== undefined && machine !== null && (
				<FolderBrowser
					tailnet={tailnet}
					machine={machine}
					path={path}
					setPath={setPath}
					onPick={pick}
					picking={save.isPending}
				/>
			)}
		</main>
	);
}
