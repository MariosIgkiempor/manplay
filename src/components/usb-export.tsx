import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, HardDriveUpload } from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer } from "#/components/drawer.tsx";
import { ErrorText } from "#/components/error-text.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	exportToUsb,
	listPlaylists,
	onUsbExportProgress,
	type UsbDrive,
	type UsbExportProgress,
	type UsbExportReport,
	type UsbLibrary,
} from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { cn } from "#/lib/utils.ts";

const plural = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

function useExportProgress(running: boolean): UsbExportProgress | null {
	const [progress, setProgress] = useState<UsbExportProgress | null>(null);
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void onUsbExportProgress(setProgress).then((fn) => {
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
	useEffect(() => {
		if (!running) {
			setProgress(null);
		}
	}, [running]);
	return progress;
}

function ProgressLine({ progress }: { progress: UsbExportProgress | null }) {
	if (progress === null) {
		return <p className="text-muted-foreground text-sm">Getting ready…</p>;
	}
	if (progress.phase === "writing") {
		return <p className="text-muted-foreground text-sm">Writing the rekordbox library…</p>;
	}
	const pct = progress.total === 0 ? 100 : Math.round((progress.done / progress.total) * 100);
	const verb = progress.phase === "analyzing" ? "Beat grid and waveform for" : "Copying";
	return (
		<div className="space-y-2">
			<div className="flex justify-between gap-3 text-sm">
				<span className="min-w-0 truncate">
					{verb} {progress.current}
				</span>
				<span className="shrink-0 text-muted-foreground tabular-nums">
					{progress.done + 1} of {progress.total}
				</span>
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-muted">
				<div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
			</div>
		</div>
	);
}

function Summary({ report, drive }: { report: UsbExportReport; drive: UsbDrive }) {
	return (
		<div className="space-y-3 rounded-lg border p-4 text-sm">
			<p className="flex items-center gap-2 font-medium">
				<Check className="size-4 text-success" />
				{plural(report.playlists, "playlist", "playlists")} on {drive.name}
			</p>
			<ul className="space-y-1 text-muted-foreground">
				<li>
					{plural(report.copied, "song", "songs")} copied ({formatBytes(report.bytesCopied)}),{" "}
					{report.alreadyThere.toLocaleString()} already there
				</li>
				{report.analyzed > 0 && (
					<li>{plural(report.analyzed, "song", "songs")} given a beat grid and waveform</li>
				)}
				<li>{plural(report.libraryTracks, "track", "tracks")} in the drive's library now</li>
				<li>
					{report.oneLibrary
						? "Written in both formats, for every Pioneer and AlphaTheta player"
						: "Written for the CDJ-3000 and older players only"}
				</li>
				{report.backup && (
					<li>
						The previous library is saved in <code className="text-xs">{report.backup}</code>
					</li>
				)}
			</ul>
			{report.oneLibraryError && (
				<p className="text-destructive text-xs">
					The OneLibrary for the CDJ-3000X, Opus Quad, XDJ-AZ and Omnis Duo could not be written, so
					the old one was removed: {report.oneLibraryError}
				</p>
			)}
			{report.failed.length > 0 && (
				<div className="space-y-1">
					<p className="font-medium text-destructive">
						{plural(report.failed.length, "problem", "problems")}
					</p>
					<ul className="space-y-1 text-xs">
						{report.failed.map((f) => (
							<li key={f.path} className="truncate" title={`${f.path}: ${f.error}`}>
								{f.path.split("/").pop()}: {f.error}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** Picks library playlists and copies them onto the drive. */
export function UsbExportButton({
	drive,
	library,
}: {
	drive: UsbDrive;
	library: UsbLibrary | undefined;
}) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists, enabled: open });
	const run = useMutation({
		mutationFn: () => exportToUsb(drive.mount, [...chosen]),
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["usb-library", drive.mount] });
			await queryClient.invalidateQueries({ queryKey: ["usb-formats", drive.mount] });
			await queryClient.invalidateQueries({ queryKey: ["usb-drives"] });
		},
	});
	const progress = useExportProgress(run.isPending);
	const onDrive = new Set(
		(library?.playlists ?? []).filter((p) => p.parentId === 0 && !p.isFolder).map((p) => p.name),
	);
	const list = (playlists.data ?? []).filter((p) => p.trackCount > 0);
	const songs = list.filter((p) => chosen.has(p.id)).reduce((n, p) => n + p.trackCount, 0);

	const toggle = (id: number) => {
		const next = new Set(chosen);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		setChosen(next);
	};
	const close = () => {
		if (!run.isPending) {
			setOpen(false);
			run.reset();
		}
	};

	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)} disabled={!drive.writable}>
				<HardDriveUpload /> Export playlists…
			</Button>
			<Drawer open={open} onClose={close} title={`Export to ${drive.name}`} width="w-[30rem]">
				<div className="space-y-5 pb-6">
					<div className="space-y-1">
						<h2 className="font-semibold text-xl tracking-tight">Export to {drive.name}</h2>
						<p className="text-muted-foreground text-sm">
							Copies the songs into <code className="text-xs">/Contents</code>, works out their beat
							grids and waveforms, and adds the playlists to the drive's rekordbox library. Songs
							already on the drive are not copied again, and everything else on it stays.
						</p>
					</div>

					{run.isSuccess ? (
						<Summary report={run.data} drive={drive} />
					) : run.isPending ? (
						<ProgressLine progress={progress} />
					) : (
						<>
							{playlists.isError && <ErrorText message={String(playlists.error)} />}
							{list.length === 0 && playlists.isSuccess && (
								<p className="py-6 text-center text-muted-foreground text-sm">
									No playlists with songs in your library.
								</p>
							)}
							<ul className="space-y-1">
								{list.map((p) => (
									<li key={p.id}>
										<label
											className={cn(
												"flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50",
												chosen.has(p.id) && "bg-muted/60",
											)}
										>
											<input
												type="checkbox"
												checked={chosen.has(p.id)}
												onChange={() => toggle(p.id)}
												className="size-4 accent-primary"
											/>
											<span className="min-w-0 flex-1">
												<span className="block truncate text-sm">{p.name}</span>
												{onDrive.has(p.name) && (
													<span className="block text-muted-foreground text-xs">
														Replaces the playlist with this name on the drive
													</span>
												)}
											</span>
											<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
												{p.trackCount}
											</span>
										</label>
									</li>
								))}
							</ul>
						</>
					)}

					{run.isError && <ErrorText message={String(run.error)} />}

					<div className="flex justify-end gap-2">
						{run.isSuccess ? (
							<Button onClick={close}>Done</Button>
						) : (
							<>
								<Button variant="ghost" onClick={close} disabled={run.isPending}>
									Cancel
								</Button>
								<Button onClick={() => run.mutate()} disabled={chosen.size === 0 || run.isPending}>
									{chosen.size === 0
										? "Export"
										: `Export ${plural(chosen.size, "playlist", "playlists")} · ${plural(songs, "song", "songs")}`}
								</Button>
							</>
						)}
					</div>
				</div>
			</Drawer>
		</>
	);
}
