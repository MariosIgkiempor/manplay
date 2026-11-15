import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	Cloud,
	Folder,
	History,
	KeyRound,
	LockKeyhole,
	Network,
	Settings2,
	Trash2,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import {
	DestinationHeader,
	FolderFigure,
	SettingLabel,
	UsageBar,
} from "#/components/destination-header.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { PullButton, SyncButton } from "#/components/sync-flow.tsx";
import { SyncReviewButton } from "#/components/sync-review.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Segmented } from "#/components/view-toggle.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { isR2, removeSyncTarget, type SyncTarget, updateSyncTarget } from "#/lib/api.ts";
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
			<SettingRows>
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
function RemoveRow({ target, onRemoved }: { target: SyncTarget; onRemoved: () => void }) {
	const queryClient = useQueryClient();
	const busy = useSyncProgress().size > 0;
	const [confirming, setConfirming] = useState(false);
	const remove = useMutation({
		mutationFn: removeSyncTarget,
		onSuccess: async () => {
			onRemoved();
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			await queryClient.invalidateQueries({ queryKey: ["sync-history"] });
			await queryClient.invalidateQueries({ queryKey: ["tracks"] });
		},
	});
	return (
		<SettingRow
			label={
				<SettingLabel
					icon={<Trash2 className="text-destructive" />}
					title="Remove destination"
					hint="manplay stops syncing here. The files already there stay."
				/>
			}
		>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="border-destructive/40 text-destructive hover:bg-destructive/10"
				onClick={() => setConfirming(true)}
				disabled={busy}
			>
				Remove…
			</Button>
			<MutationErrors mutations={[remove]} />
			{confirming && (
				<ConfirmDialog
					title={`Remove ${target.machine}?`}
					confirmLabel="Remove destination"
					destructive
					busy={remove.isPending}
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						remove.mutate(target.id);
					}}
				>
					manplay stops syncing there. Files already in {target.path.join(" / ") || "the bucket"}{" "}
					stay.
				</ConfirmDialog>
			)}
		</SettingRow>
	);
}

type Tab = "history" | "settings";

/** One machine/folder or bucket/folder: what it holds, its settings and its own sync history. */
export function TargetDetail({ id, onRemoved }: { id: number; onRemoved: () => void }) {
	const targets = useSyncTargets();
	const history = useSyncHistory();
	const tracks = useTracks();
	const busy = useSyncProgress().size > 0;
	const [tab, setTab] = useState<Tab>("history");
	const target = targets.data?.find((t) => t.id === id);
	if (!target) {
		return null;
	}
	const r2 = isR2(target);
	const total = tracks.data?.length ?? 0;
	const where = target.path.join(" / ") || "Bucket root";
	return (
		<div className="space-y-5 pb-6">
			<DestinationHeader
				brand={r2 ? "cloudflare" : "tailscale"}
				kind={
					r2 ? (
						<>
							<Cloud /> R2 bucket
						</>
					) : (
						<>
							<Network /> Tailscale folder
						</>
					)
				}
				title={target.machine}
				meta={
					<>
						<UsageBar value={target.syncedTracks} total={total} tone="progress">
							{target.syncedTracks.toLocaleString()} of {total.toLocaleString()} songs synced
						</UsageBar>
						<FolderFigure path={where} />
					</>
				}
				actions={
					<>
						<SyncButton ids={[target.id]} disabled={busy} />
						<PullButton ids={[target.id]} disabled={busy} />
						<SyncReviewButton ids={[target.id]} variant="outline" disabled={busy} />
					</>
				}
				tabs={
					<Segmented
						className="border-b-0"
						value={tab}
						onChange={setTab}
						label="Destination view"
						items={[
							{ value: "history", label: "History", icon: <History /> },
							{ value: "settings", label: "Settings", icon: <Settings2 /> },
						]}
					/>
				}
			/>
			{tab === "history" ? (
				<HistoryList
					entries={syncEntries((history.data ?? []).filter((r) => r.targetId === id))}
					empty="Never synced."
				/>
			) : (
				<SettingsForm key={id} target={target}>
					<RemoveRow target={target} onRemoved={onRemoved} />
				</SettingsForm>
			)}
		</div>
	);
}

/** A destination in the details panel; removing it closes the panel. */
export function TargetPanel({ id }: { id: number }) {
	const { close } = useDetail();
	return <TargetDetail id={id} onRemoved={close} />;
}
