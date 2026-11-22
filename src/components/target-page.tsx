import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	Folder,
	FolderOpen,
	History,
	KeyRound,
	LockKeyhole,
	Network,
	RefreshCw,
	Settings2,
	Trash2,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { DestinationHeader, SettingLabel, UsageBar } from "#/components/destination-header.tsx";
import { HeaderMenu } from "#/components/header-menu.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { JellyfinSection } from "#/components/jellyfin-section.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { PlaceFrame } from "#/components/place-page.tsx";
import { removalConsequence, useRemoveDestination } from "#/components/remove-destination.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { SyncPanel } from "#/components/sync-summary.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { isR2, type SyncTarget, targetShortName, updateSyncTarget } from "#/lib/api.ts";
import { syncEntries } from "#/lib/history.ts";
import { useSyncHistory, useSyncTargets, useTracks } from "#/lib/queries.ts";
import { useAutosave } from "#/lib/unsaved.tsx";

/** A text setting as a settings row: name and hint on the left, the field on the right. */
function Field({
	icon,
	label,
	hint,
	...props
}: {
	icon: ReactNode;
	label: string;
	hint?: string | undefined;
} & React.ComponentProps<typeof Input>) {
	const id = useId();
	return (
		<SettingRow
			label={
				<label htmlFor={id}>
					<SettingLabel icon={icon} title={label} hint={hint} />
				</label>
			}
		>
			<Input id={id} autoComplete="off" spellCheck={false} className="w-60" {...props} />
		</SettingRow>
	);
}

const MOVE_HINT =
	"Changing the folder re-uploads your library there. Files at the old location are left untouched.";

const parsePath = (raw: string) =>
	raw
		.split("/")
		.map((s) => s.trim())
		.filter(Boolean);

function CredentialFields(p: {
	keyId: string;
	secret: string;
	incomplete: boolean;
	onKeyId: (v: string) => void;
	onSecret: (v: string) => void;
}) {
	return (
		<>
			<Field
				icon={<KeyRound />}
				label="Access Key ID"
				value={p.keyId}
				placeholder="Unchanged"
				onChange={(e) => p.onKeyId(e.target.value)}
			/>
			<Field
				icon={<LockKeyhole />}
				label="Secret Access Key"
				type="password"
				value={p.secret}
				placeholder="Unchanged"
				onChange={(e) => p.onSecret(e.target.value)}
				hint={
					p.incomplete
						? "Enter both the key ID and the secret to replace credentials."
						: "Leave both empty to keep the saved ones."
				}
			/>
		</>
	);
}

/** A destination's settings on their own, for the Export page's Settings of every destination. */
export function DestinationSettings({ target }: { target: SyncTarget }) {
	const removal = useRemoveDestination();
	return (
		<div key={target.id} className="space-y-6">
			<SettingsForm target={target}>
				<RemoveRow
					target={target}
					onRemove={() => removal.remove(target)}
					busy={removal.busy || removal.removing}
				/>
			</SettingsForm>
			<JellyfinSection targetId={target.id} />
			{removal.error && <ErrorLine>{String(removal.error)}</ErrorLine>}
		</div>
	);
}

function SettingsForm({ target, children }: { target: SyncTarget; children?: ReactNode }) {
	const queryClient = useQueryClient();
	const storedPath = target.path.join(" / ");
	const [folder, setFolder] = useState(storedPath);
	const [keyId, setKeyId] = useState("");
	const [secret, setSecret] = useState("");

	const save = useMutation({
		mutationFn: updateSyncTarget,
		onSuccess: async (_, sent) => {
			// Only what was sent: anything typed while saving stays to be saved next.
			if (sent.keyId !== undefined) {
				setKeyId((k) => (k === sent.keyId ? "" : k));
				setSecret((v) => (v === sent.secret ? "" : v));
			}
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
		},
	});

	const id = target.id;
	const r2 = isR2(target);
	const pathChanged = parsePath(folder).join("/") !== target.path.join("/");
	const credsChanged = r2 && (keyId.trim() !== "" || secret !== "");
	const credsIncomplete = credsChanged && (keyId.trim() === "" || secret === "");
	const autosave = useAutosave({
		label: `Settings of ${target.machine}`,
		value: { folder, keyId, secret },
		saved: { folder: storedPath, keyId: "", secret: "" },
		equal: (a, b) =>
			parsePath(a.folder).join("/") === parsePath(b.folder).join("/") &&
			a.keyId.trim() === b.keyId.trim() &&
			a.secret === b.secret,
		canSave: (v) => {
			const creds = r2 && (v.keyId.trim() !== "" || v.secret !== "");
			const partial = creds && (v.keyId.trim() === "" || v.secret === "");
			return !partial && (r2 || parsePath(v.folder).length > 0);
		},
		save: (v) => {
			const creds = r2 && (v.keyId.trim() !== "" || v.secret !== "");
			return save.mutateAsync({
				id,
				path: parsePath(v.folder),
				keyId: creds ? v.keyId : undefined,
				secret: creds ? v.secret : undefined,
			});
		},
	});

	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				void autosave.flush();
			}}
		>
			<SettingRows title="Destination">
				<Field
					icon={<Folder />}
					label={r2 ? "Folder in bucket" : "Shared folder"}
					value={folder}
					placeholder={r2 ? "(bucket root)" : "Music / Backup"}
					onChange={(e) => setFolder(e.target.value)}
					hint={
						pathChanged
							? MOVE_HINT
							: r2
								? "Separate subfolders with /"
								: "The share, then subfolders, separated by /"
					}
				/>
				{r2 && (
					<CredentialFields
						keyId={keyId}
						secret={secret}
						incomplete={credsIncomplete}
						onKeyId={setKeyId}
						onSecret={setSecret}
					/>
				)}
				{children}
			</SettingRows>
			<SaveState
				status={autosave.status}
				error={autosave.error}
				invalid={r2 ? "Enter both credentials to save them" : "Choose a shared folder"}
			/>
		</form>
	);
}

/** Removing the destination, as the last settings row. */
function RemoveRow({
	target,
	onRemove,
	busy,
}: {
	target: SyncTarget;
	onRemove: () => void;
	busy: boolean;
}) {
	return (
		<SettingRow
			label={
				<SettingLabel
					icon={<Trash2 className="text-destructive" />}
					title="Remove destination"
					hint="manplay stops syncing here and forgets it. The files there stay."
				/>
			}
		>
			<ConfirmButton
				type="button"
				size="sm"
				variant="outline"
				className="border-destructive/40 text-destructive hover:bg-destructive/10"
				disabled={busy}
				destructive
				confirmLabel={`Remove ${targetShortName(target)}`}
				consequence={removalConsequence(target)}
				onConfirm={onRemove}
			>
				Remove
			</ConfirmButton>
		</SettingRow>
	);
}

type Tab = "sync" | "history" | "settings";

/**
 * One machine/folder or bucket/folder: what a sync would do (read in the background, so it shows
 * at once), its own sync history and its settings.
 */
export function TargetPage({ id, onRemoved }: { id: number; onRemoved: () => void }) {
	const navigate = useNavigate();
	const targets = useSyncTargets();
	const history = useSyncHistory();
	const tracks = useTracks();
	const [tab, setTab] = useState<Tab>("sync");
	const removal = useRemoveDestination(onRemoved);
	const target = targets.data?.find((t) => t.id === id);
	if (!target) {
		return targets.isPending ? null : (
			<EmptyState icon={<Network />} title="Destination removed">
				It is no longer in your destinations.
			</EmptyState>
		);
	}
	const r2 = isR2(target);
	const total = tracks.data?.length ?? 0;
	const where = target.path.join(" / ") || "Bucket root";
	return (
		<PlaceFrame
			flush={tab === "sync"}
			header={
				<DestinationHeader
					section="export"
					place={`target:${id}`}
					brand={r2 ? "cloudflare" : "tailscale"}
					title={targetShortName(target)}
					actions={
						<HeaderMenu
							size="sm"
							entries={[
								{
									label: "Browse files",
									icon: <FolderOpen />,
									onSelect: () => void navigate({ to: "/files", search: { target: id } }),
								},
								"separator",
								{
									label: "Remove destination…",
									icon: <Trash2 />,
									destructive: true,
									disabled: removal.busy,
									onSelect: () => removal.ask(target),
								},
							]}
						/>
					}
					titleHint={`${target.machine}: ${where}`}
					meta={
						<UsageBar value={target.syncedTracks} total={total} tone="progress">
							{target.syncedTracks.toLocaleString()} of {total.toLocaleString()} songs synced
						</UsageBar>
					}
					tabs={
						<Segmented
							className="border-b-0"
							value={tab}
							onChange={setTab}
							label="Destination view"
							items={[
								{ value: "sync", label: "Sync", icon: <RefreshCw /> },
								{ value: "history", label: "History", icon: <History /> },
								{ value: "settings", label: "Settings", icon: <Settings2 /> },
							]}
						/>
					}
				/>
			}
		>
			{tab === "sync" ? (
				<SyncPanel key={id} ids={[id]} variant="page" />
			) : tab === "history" ? (
				<HistoryList
					entries={syncEntries((history.data ?? []).filter((r) => r.targetId === id))}
					empty="Never synced."
					titled={false}
				/>
			) : (
				// Keyed as a whole: both forms start again for another destination.
				<div key={id} className="space-y-6">
					<SettingsForm target={target}>
						<RemoveRow
							target={target}
							onRemove={() => removal.remove(target)}
							busy={removal.busy || removal.removing}
						/>
					</SettingsForm>
					<JellyfinSection targetId={id} />
				</div>
			)}
			{removal.error && <ErrorLine>{String(removal.error)}</ErrorLine>}
			{removal.dialog}
		</PlaceFrame>
	);
}
