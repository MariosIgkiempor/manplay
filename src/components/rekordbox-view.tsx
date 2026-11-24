import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, FolderOpen } from "lucide-react";
import { useState } from "react";
import {
	type ChooserTab,
	ExportChooser,
	ExportFooter,
	HeldPlaylists,
} from "#/components/export-chooser.tsx";
import { EmptyLine, ErrorLine, LoadingLine } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { PanelBarTitle } from "#/context/panel-bar.tsx";
import {
	type ExportSelection,
	listPlaylists,
	rekordboxLibrary,
	rekordboxSelection,
	setRekordboxSelection,
} from "#/lib/api.ts";
import { EMPTY_SELECTION, plural } from "#/lib/export-selection.ts";
import { timeAgo } from "#/lib/format.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { useRekordbox } from "#/lib/use-rekordbox.ts";
import { useSmartPlaylists } from "#/lib/use-smart.ts";
import { cn } from "#/lib/utils.ts";

/** The file is written whole each time, so no playlist in it is replaced by name. */
const NOTHING: ReadonlySet<string> = new Set();

function InFile() {
	const library = useQuery({ queryKey: ["rekordbox-library"], queryFn: rekordboxLibrary });
	if (library.isError) {
		return <ErrorLine>{String(library.error)}</ErrorLine>;
	}
	if (library.isPending) {
		return <LoadingLine>Reading the file…</LoadingLine>;
	}
	if (library.data === null) {
		return <EmptyLine className="px-0">Not exported yet</EmptyLine>;
	}
	return <HeldPlaylists playlists={library.data.playlists} empty="The file has no playlists." />;
}

/** The file's name and what it holds, as the USB export drawer shows the drive and its space. */
function FileTitle({
	path,
	tracks,
	playlists,
	exportedAt,
}: {
	path: string | null;
	tracks: number | null;
	playlists: number | null;
	exportedAt: number | null;
}) {
	return (
		<div className="space-y-1">
			<h2 className={cn("truncate", typeScale.panelTitle)} data-hint={path ?? undefined}>
				{path === null ? "rekordbox" : (path.split(/[\\/]/).pop() ?? path)}
			</h2>
			<p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs tabular-nums">
				{tracks !== null && <span>{plural(tracks, "track")} in the file</span>}
				{playlists !== null && <span>{plural(playlists, "playlist")}</span>}
				<span>{exportedAt === null ? "Never exported" : `Exported ${timeAgo(exportedAt)}`}</span>
			</p>
		</div>
	);
}

function NoFile({ onChoose, pending }: { onChoose: () => void; pending: boolean }) {
	return (
		<div className="space-y-3 rounded-xl border border-hairline border-dashed p-5 text-center">
			<p className="text-sm">Choose where manplay should save the rekordbox file.</p>
			<Button onClick={onChoose} disabled={pending}>
				<FolderOpen /> Choose location…
			</Button>
		</div>
	);
}

/**
 * Choose what goes into the rekordbox file and write it. The choice is saved with the export, so
 * it always shows what the file holds.
 */
export function RekordboxExport({ onClose }: { onClose: () => void }) {
	const queryClient = useQueryClient();
	const { status, choose } = useRekordbox();
	const saved = useQuery({ queryKey: ["rekordbox-selection"], queryFn: rekordboxSelection });
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const library = useQuery({ queryKey: ["rekordbox-library"], queryFn: rekordboxLibrary });
	const [draft, setDraft] = useState<ExportSelection | null>(null);
	const [tab, setTab] = useState<ChooserTab>("playlists");
	const selection = draft ?? saved.data ?? EMPTY_SELECTION;

	const exportNow = useMutation({
		mutationFn: setRekordboxSelection,
		onSuccess: (next) => {
			queryClient.setQueryData(["rekordbox-selection"], next);
			setDraft(null);
			for (const key of [["rekordbox"], ["rekordbox-library"], ["activity", "rekordbox"]]) {
				void queryClient.invalidateQueries({ queryKey: key });
			}
			setTab("destination");
		},
	});

	const path = status.data?.path ?? null;
	const ids = new Set((playlists.data ?? []).map((p) => p.id));
	const smart = useSmartPlaylists();
	const smartIds = new Set((smart.data ?? []).map((p) => p.id));
	const count =
		selection.playlists.filter((id) => ids.has(id)).length +
		selection.tags.length +
		selection.smart.filter((id) => smartIds.has(id)).length;

	return (
		<div className="flex min-h-full flex-col gap-5">
			<PanelBarTitle>
				<span className="truncate font-medium text-sm">Export to rekordbox</span>
			</PanelBarTitle>
			<FileTitle
				path={path}
				tracks={library.data?.tracks ?? null}
				playlists={library.data?.playlists.length ?? null}
				exportedAt={status.data?.exportedAt ?? null}
			/>
			{status.isSuccess && path === null ? (
				<NoFile onChoose={() => choose.mutate()} pending={choose.isPending} />
			) : (
				<ExportChooser
					selection={selection}
					onChange={setDraft}
					tab={tab}
					onTab={setTab}
					replaces={NOTHING}
					onLeave={onClose}
					destination={{
						label: "In rekordbox",
						icon: <FileDown />,
						content: <InFile />,
					}}
				/>
			)}
			<MutationErrors mutations={[exportNow, choose]} />
			{path !== null && (
				<ExportFooter
					inPanel
					text={`${plural(count, "playlist")}${draft === null ? " in the file" : ", not exported yet"}`}
				>
					<Button variant="ghost" onClick={onClose} disabled={exportNow.isPending}>
						Cancel
					</Button>
					<Button onClick={() => exportNow.mutate(selection)} disabled={exportNow.isPending}>
						{exportNow.isPending ? "Exporting…" : "Export"}
					</Button>
				</ExportFooter>
			)}
		</div>
	);
}

/** The rekordbox export in the side panel, beside the page it was opened from. */
export function RekordboxExportPanel() {
	const detail = useDetail();
	return <RekordboxExport onClose={detail.close} />;
}

/** Button that opens the export in the side panel; nothing is written until its own button is used. */
export function RekordboxExportButton({
	size,
	variant,
	label = "Export…",
}: {
	size?: "sm" | "default";
	variant?: "default" | "outline";
	label?: string;
}) {
	const detail = useDetail();
	const open = detail.view?.kind === "rekordboxExport";
	return (
		<Button
			size={size}
			variant={open ? "secondary" : variant}
			aria-pressed={open}
			onClick={() => (open ? detail.close() : detail.open({ kind: "rekordboxExport" }))}
		>
			<FileDown /> {label}
		</Button>
	);
}
