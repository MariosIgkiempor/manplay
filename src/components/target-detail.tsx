import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { BrandIcon } from "#/components/brand-icon.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { HistoryList } from "#/components/history-list.tsx";
import { Section } from "#/components/page.tsx";
import { MutationErrors } from "#/components/path-setting.tsx";
import { PullButton, SyncButton } from "#/components/sync-flow.tsx";
import { SyncReviewButton } from "#/components/sync-review.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useSyncProgress } from "#/context/sync-progress-context.ts";
import { isR2, removeSyncTarget, type SyncTarget, updateSyncTarget } from "#/lib/api.ts";
import { syncEntries } from "#/lib/history.ts";
import { useSyncHistory, useSyncTargets, useTracks } from "#/lib/queries.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { cn } from "#/lib/utils.ts";

function Field({
	label,
	hint,
	...props
}: { label: string; hint?: string | undefined } & React.ComponentProps<typeof Input>) {
	const id = useId();
	return (
		<div className="space-y-1.5 text-sm">
			<label htmlFor={id} className="font-medium text-xs">
				{label}
			</label>
			<Input id={id} autoComplete="off" spellCheck={false} className="h-9" {...props} />
			{hint && <p className="text-muted-foreground text-xs">{hint}</p>}
		</div>
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
				label="Access Key ID"
				value={p.keyId}
				placeholder="Unchanged"
				onChange={(e) => p.onKeyId(e.target.value)}
			/>
			<Field
				label="Secret Access Key"
				type="password"
				value={p.secret}
				placeholder="Unchanged"
				onChange={(e) => p.onSecret(e.target.value)}
				hint={
					p.incomplete ? "Enter both the key ID and the secret to replace credentials." : undefined
				}
			/>
		</>
	);
}

function FormActions(p: {
	canSave: boolean;
	dirty: boolean;
	pending: boolean;
	saved: boolean;
	onReset: () => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<Button type="submit" disabled={!p.canSave || p.pending}>
				{p.pending ? "Saving…" : "Save changes"}
			</Button>
			{p.dirty && !p.pending && (
				<Button type="button" variant="ghost" onClick={p.onReset}>
					Reset
				</Button>
			)}
			{p.saved && !p.dirty && <span className="text-muted-foreground text-xs">Saved</span>}
		</div>
	);
}

function SettingsForm({ target }: { target: SyncTarget }) {
	const queryClient = useQueryClient();
	const storedPath = target.path.join(" / ");
	const [folder, setFolder] = useState(storedPath);
	const [keyId, setKeyId] = useState("");
	const [secret, setSecret] = useState("");
	useEffect(() => setFolder(storedPath), [storedPath]);

	const save = useMutation({
		mutationFn: updateSyncTarget,
		onSuccess: async () => {
			setSecret("");
			setKeyId("");
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
		},
	});

	const id = target.id;
	const r2 = isR2(target);
	const pathChanged = parsePath(folder).join("/") !== target.path.join("/");
	const credsChanged = r2 && (keyId.trim() !== "" || secret !== "");
	const credsIncomplete = credsChanged && (keyId.trim() === "" || secret === "");
	const dirty = pathChanged || credsChanged;

	return (
		<form
			className="space-y-4"
			onSubmit={(e) => {
				e.preventDefault();
				save.mutate({
					id,
					path: parsePath(folder),
					keyId: credsChanged ? keyId : undefined,
					secret: credsChanged ? secret : undefined,
				});
			}}
		>
			<Field
				label={r2 ? "Folder in bucket" : "Shared folder (share / subfolders)"}
				value={folder}
				placeholder={r2 ? "(bucket root)" : "Music / Backup"}
				onChange={(e) => setFolder(e.target.value)}
				hint={pathChanged ? MOVE_HINT : "Separate subfolders with /"}
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
			<FormActions
				canSave={dirty && !credsIncomplete}
				dirty={dirty}
				pending={save.isPending}
				saved={save.isSuccess}
				onReset={() => {
					setFolder(storedPath);
					setKeyId("");
					setSecret("");
				}}
			/>
			{save.isError && <p className="text-destructive text-sm">{String(save.error)}</p>}
		</form>
	);
}

function Actions({ target, onRemoved }: { target: SyncTarget; onRemoved: () => void }) {
	const queryClient = useQueryClient();
	const progress = useSyncProgress();
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
	const busy = progress.size > 0;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-2">
				<SyncButton ids={[target.id]} disabled={busy} />
				<PullButton ids={[target.id]} disabled={busy} />
				<SyncReviewButton ids={[target.id]} variant="outline" disabled={busy} />
				<Button
					variant="ghost"
					className="ml-auto hover:text-destructive"
					onClick={() => setConfirming(true)}
					disabled={busy}
				>
					<Trash2 /> Remove
				</Button>
			</div>
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
		</div>
	);
}

/** One machine/folder or bucket/folder: what it holds, its settings and its own sync history. */
export function TargetDetail({ id, onRemoved }: { id: number; onRemoved: () => void }) {
	const targets = useSyncTargets();
	const history = useSyncHistory();
	const tracks = useTracks();
	const target = targets.data?.find((t) => t.id === id);
	if (!target) {
		return null;
	}
	const r2 = isR2(target);
	const total = tracks.data?.length ?? 0;
	return (
		<div className="space-y-8 pb-6">
			<div className="space-y-5">
				<div className="flex items-center gap-3">
					<BrandIcon brand={r2 ? "cloudflare" : "tailscale"} className="size-10" />
					<div className="min-w-0">
						<div className="text-muted-foreground text-xs">
							{r2 ? "Cloudflare R2 bucket" : "Tailscale folder"}
						</div>
						<h2 className={cn("truncate", typeScale.panelTitle)}>{target.machine}</h2>
						<p className="truncate text-muted-foreground text-sm">
							{target.path.join(" / ") || "Bucket root"}
						</p>
					</div>
				</div>
				<div className="space-y-1.5">
					<p className="text-sm tabular-nums">
						<span className="font-medium">{target.syncedTracks.toLocaleString()}</span>
						<span className="text-muted-foreground"> of {total.toLocaleString()} songs synced</span>
					</p>
					<div className="h-1 overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-primary"
							style={{
								width: `${total === 0 ? 0 : Math.min(100, (target.syncedTracks / total) * 100)}%`,
							}}
						/>
					</div>
				</div>
				<Actions target={target} onRemoved={onRemoved} />
			</div>
			<Section title="Settings">
				<SettingsForm key={id} target={target} />
			</Section>
			<Section title="History">
				<HistoryList
					entries={syncEntries((history.data ?? []).filter((r) => r.targetId === id))}
					empty="Never synced."
				/>
			</Section>
		</div>
	);
}

/** A destination in the details panel; removing it closes the panel. */
export function TargetPanel({ id }: { id: number }) {
	const { close } = useDetail();
	return <TargetDetail id={id} onRemoved={close} />;
}
