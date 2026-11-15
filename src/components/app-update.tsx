import { Download, RefreshCw } from "lucide-react";
import { ErrorLine, Panel, Section } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useAppVersion, useInstallUpdate, useUpdateCheck } from "#/lib/updater.ts";

/** App version plus update check / install, backed by GitHub releases. */
export function AppUpdate() {
	const version = useAppVersion();
	const update = useUpdateCheck();
	const install = useInstallUpdate();
	const available = update.data;

	let status = "Up to date";
	if (install.isPending) {
		status = "Installing…";
	} else if (update.isFetching) {
		status = "Checking for updates…";
	} else if (update.isError) {
		status = `Could not check for updates: ${String(update.error)}`;
	} else if (available) {
		status = `Version ${available.version} is available`;
	}

	return (
		<Section title="About">
			<Panel className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0 space-y-0.5">
					<p className="font-medium text-sm tabular-nums">manplay {version.data ?? ""}</p>
					<p className="text-muted-foreground text-xs">{status}</p>
				</div>
				{available ? (
					<Button onClick={() => install.mutate()} disabled={install.isPending}>
						<Download />
						Install and restart
					</Button>
				) : (
					<Button variant="outline" onClick={() => update.refetch()} disabled={update.isFetching}>
						<RefreshCw className={update.isFetching ? "animate-spin" : ""} />
						Check for updates
					</Button>
				)}
				{install.isError && <ErrorLine>{String(install.error)}</ErrorLine>}
			</Panel>
		</Section>
	);
}
