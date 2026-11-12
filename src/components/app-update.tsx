import { Download, RefreshCw } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { useAppVersion, useInstallUpdate, useUpdateCheck } from "#/lib/updater.ts";

/** App version plus update check / install, backed by GitHub releases. */
export function AppUpdate() {
	const version = useAppVersion();
	const update = useUpdateCheck();
	const install = useInstallUpdate();
	const available = update.data;

	let status = "Up to date.";
	if (update.isFetching) {
		status = "Checking for updates…";
	} else if (update.isError) {
		status = `Could not check for updates: ${String(update.error)}`;
	} else if (available) {
		status = `Version ${available.version} is available.`;
	}

	return (
		<section className="space-y-3 rounded-xl border bg-card p-4">
			<h2 className="font-medium">About</h2>
			<p className="text-muted-foreground text-sm">manplay {version.data ?? ""}</p>
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-0 flex-1 text-sm">{install.isPending ? "Installing…" : status}</span>
				{available ? (
					<Button onClick={() => install.mutate()} disabled={install.isPending}>
						<Download />
						Install &amp; restart
					</Button>
				) : (
					<Button variant="outline" onClick={() => update.refetch()} disabled={update.isFetching}>
						<RefreshCw className={update.isFetching ? "animate-spin" : ""} />
						Check for updates
					</Button>
				)}
			</div>
			{install.isError && <p className="text-destructive text-xs">{String(install.error)}</p>}
		</section>
	);
}
