import { Download, RefreshCw } from "lucide-react";
import { FieldRow, FrameSection } from "#/components/frame.tsx";
import { ErrorLine } from "#/components/page.tsx";
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
		<FrameSection title="About">
			<FieldRow
				label={<span className="tabular-nums">manplay {version.data ?? ""}</span>}
				description={status}
				align="center"
			>
				{available ? (
					<Button onClick={() => install.mutate()} disabled={install.isPending}>
						<Download />
						Install and restart
					</Button>
				) : (
					<Button variant="outline" onClick={() => update.refetch()} disabled={update.isFetching}>
						<RefreshCw
							className={update.isFetching ? "animate-spin motion-reduce:animate-none" : ""}
						/>
						Check for updates
					</Button>
				)}
			</FieldRow>
			{install.isError && (
				<div className="px-4 py-3">
					<ErrorLine>{String(install.error)}</ErrorLine>
				</div>
			)}
		</FrameSection>
	);
}
