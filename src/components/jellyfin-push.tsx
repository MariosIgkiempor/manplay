import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { SettingLabel } from "#/components/destination-header.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { ExportFooter } from "#/components/export-chooser.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { SettingRow } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { type JellyfinPlanRow, jellyfinPlan, pushJellyfin } from "#/lib/api.ts";
import { plural } from "#/lib/export-selection.ts";
import { timeAgo } from "#/lib/format.ts";
import { pushSummaryText } from "#/lib/jellyfin-text.ts";
import { WELL_ROWS } from "#/lib/page-layout.ts";
import { useJellyfinDestinations } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

const ACTION: Record<JellyfinPlanRow["action"], { label: string; tone: string; order: number }> = {
	create: { label: "New", tone: "bg-success/15 text-success", order: 0 },
	update: { label: "Updated", tone: "bg-warning/15 text-warning", order: 1 },
	rename: { label: "Renamed", tone: "bg-warning/15 text-warning", order: 2 },
	reshare: { label: "Sharing changed", tone: "bg-warning/15 text-warning", order: 3 },
	remove: { label: "Removed", tone: "bg-destructive/10 text-destructive", order: 4 },
	unchanged: { label: "Unchanged", tone: "bg-muted text-muted-foreground", order: 5 },
};

function Pill({ tone, children }: { tone: string; children: string }) {
	return (
		<span className={cn("shrink-0 rounded-full px-2 py-0.5 font-medium text-xs", tone)}>
			{children}
		</span>
	);
}

function rowDetail(row: JellyfinPlanRow): string {
	if (row.action === "remove") {
		return "Deleted from Jellyfin (a copy of its song list is kept)";
	}
	const parts = [plural(row.songs, "song")];
	if (row.added > 0 || row.removed > 0) {
		parts.push(`+${row.added} −${row.removed}`);
	}
	if (row.action === "reshare") {
		parts.push("made again for the people now chosen, the old one deleted");
	}
	if (row.oldName !== null) {
		parts.push(`was “${row.oldName}”`);
	}
	if (row.leftOut > 0) {
		parts.push(`${row.leftOut} not in Jellyfin`);
	}
	return parts.join(" · ");
}

function PlanList({ rows }: { rows: JellyfinPlanRow[] }) {
	const sorted = [...rows].sort(
		(a, b) => ACTION[a.action].order - ACTION[b.action].order || a.name.localeCompare(b.name),
	);
	if (sorted.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				No playlists chosen yet: pick them under Playlists.
			</p>
		);
	}
	return (
		<ul className={`${WELL_ROWS} px-4`}>
			{sorted.map((row) => (
				<li key={row.key} className="flex items-center gap-3 py-2">
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm">{row.name}</div>
						<div className="truncate text-muted-foreground text-xs tabular-nums">
							{rowDetail(row)}
						</div>
					</div>
					{row.adopted && (
						<Pill tone="bg-warning/15 text-warning">Made outside manplay: taken over</Pill>
					)}
					<Pill tone={ACTION[row.action].tone}>{ACTION[row.action].label}</Pill>
				</li>
			))}
		</ul>
	);
}

function Review({ targetId, onClose }: { targetId: number; onClose: () => void }) {
	const queryClient = useQueryClient();
	const plan = useQuery({
		queryKey: ["jellyfin-plan", targetId],
		queryFn: () => jellyfinPlan(targetId),
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	const send = useMutation({
		mutationFn: pushJellyfin,
		onSuccess: async () => {
			for (const key of [["jellyfin-destinations"], ["jellyfin-server-playlists", targetId]]) {
				await queryClient.invalidateQueries({ queryKey: key });
			}
			onClose();
		},
	});
	const rows = plan.data ?? [];
	const changing = rows.filter((r) => r.action !== "unchanged" || r.adopted).length;
	return (
		<div className="flex min-h-full flex-col gap-4">
			<Facts label="What Send changes in Jellyfin. A playlist's song list is saved here before it is changed or deleted.">
				<Fact tone="changed">What Send changes</Fact>
				<Fact tone="kept">Song lists backed up first</Fact>
			</Facts>
			{plan.isPending && <p className="text-muted-foreground text-sm">Reading Jellyfin…</p>}
			{plan.isError && <ErrorLine>{String(plan.error)}</ErrorLine>}
			{plan.isSuccess && <PlanList rows={rows} />}
			{send.isError && <ErrorLine>{String(send.error)}</ErrorLine>}
			<ExportFooter
				text={plan.isSuccess ? `${plural(changing, "playlist")} to change` : ""}
				warn={rows.some((r) => r.action === "remove")}
			>
				<Button variant="ghost" onClick={onClose} disabled={send.isPending}>
					Cancel
				</Button>
				<Button
					onClick={() => send.mutate(targetId)}
					disabled={!plan.isSuccess || changing === 0 || send.isPending}
				>
					{send.isPending ? "Sending…" : "Send"}
				</Button>
			</ExportFooter>
		</div>
	);
}

/** Sending the chosen playlists: what the last push did, and a review to send now. */
export function JellyfinPushRow({ targetId }: { targetId: number }) {
	const destinations = useJellyfinDestinations();
	const [open, setOpen] = useState(false);
	const last = destinations.data?.find((d) => d.targetId === targetId)?.lastPush ?? null;
	return (
		<SettingRow
			label={
				<SettingLabel
					icon={<Send />}
					title="Send playlists"
					hint={
						last ? (
							`Sent ${timeAgo(last.at)}: ${pushSummaryText(last.summary)}.`
						) : (
							<Facts label="Sent after each sync. Renames, removals and take-overs wait for review.">
								<Fact tone="changed">After each sync</Fact>
								<Fact tone="warn">Renames, removals, take-overs: review</Fact>
							</Facts>
						)
					}
				/>
			}
		>
			<Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
				Review and send…
			</Button>
			<Drawer
				open={open}
				onClose={() => setOpen(false)}
				title="Send playlists to Jellyfin"
				width="w-[44rem]"
			>
				{open && <Review targetId={targetId} onClose={() => setOpen(false)} />}
			</Drawer>
		</SettingRow>
	);
}
