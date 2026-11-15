import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, RefreshCw, Smartphone } from "lucide-react";
import { useState } from "react";
import { FolderBrowser } from "#/components/folder-browser.tsx";
import { ErrorLine, SectionHeading } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { addR2Target, addSyncTarget, type Machine, tailscaleStatus } from "#/lib/api.ts";
import { typeScale } from "#/lib/type-scale.ts";
import { cn } from "#/lib/utils.ts";

function MachineButton({
	machine,
	active,
	onClick,
}: {
	machine: Machine;
	active: boolean;
	onClick: () => void;
}) {
	const Icon = /ios|android/i.test(machine.os) ? Smartphone : Monitor;
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={!machine.online}
			className={cn(
				"flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50",
				active && "border-primary bg-muted",
			)}
		>
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1">
				<span className="block truncate">
					{machine.hostName}
					{machine.isSelf && " (this machine)"}
				</span>
				<span className="block text-muted-foreground text-xs">
					{machine.online ? machine.os : `Offline, ${machine.os}`}
				</span>
			</span>
		</button>
	);
}

const R2_FIELDS = [
	["account", "Account ID", "text", "In the Cloudflare dashboard, under R2"],
	["bucket", "Bucket", "text", ""],
	["prefix", "Folder in bucket", "text", "Optional. Leave empty for the bucket root"],
	["keyId", "Access key ID", "text", ""],
	["secret", "Secret access key", "password", "Kept in your system keychain"],
] as const;

/** Credentials for a Cloudflare R2 bucket. The secret is stored in the OS keychain. */
export function AddR2({ onAdded }: { onAdded: (id: number) => void }) {
	const queryClient = useQueryClient();
	const [form, setForm] = useState({
		account: "",
		bucket: "",
		prefix: "",
		keyId: "",
		secret: "",
	});
	const add = useMutation({
		mutationFn: addR2Target,
		onSuccess: async (id) => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			onAdded(id);
		},
	});
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				add.mutate(form);
			}}
		>
			<div className="space-y-4">
				{R2_FIELDS.map(([key, label, type, hint]) => (
					<div key={key} className="space-y-1.5 text-sm">
						<label htmlFor={`r2-${key}`} className={typeScale.label}>
							{label}
						</label>
						<Input
							id={`r2-${key}`}
							type={type}
							value={form[key]}
							onChange={(e) => setForm({ ...form, [key]: e.target.value })}
							autoComplete="off"
							spellCheck={false}
							className="h-9"
						/>
						{hint && <p className="text-muted-foreground text-xs">{hint}</p>}
					</div>
				))}
			</div>
			{add.isError && <ErrorLine>{String(add.error)}</ErrorLine>}
			<Button
				type="submit"
				className="w-full"
				disabled={
					add.isPending ||
					form.account === "" ||
					form.bucket === "" ||
					form.keyId === "" ||
					form.secret === ""
				}
			>
				{add.isPending ? "Checking the bucket…" : "Add bucket"}
			</Button>
		</form>
	);
}

/** Pick a Tailscale machine, browse its Taildrive folders, and add one as a destination. */
export function AddTailscale({ onAdded }: { onAdded: (id: number) => void }) {
	const queryClient = useQueryClient();
	const [machine, setMachine] = useState<string | null>(null);
	const [path, setPath] = useState<string[]>([]);
	const status = useQuery({ queryKey: ["ts-status"], queryFn: tailscaleStatus });
	const tailnet = status.data?.tailnet;

	const add = useMutation({
		mutationFn: addSyncTarget,
		onSuccess: async (id) => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			onAdded(id);
		},
	});

	const pick = () => {
		if (tailnet !== undefined && machine !== null && path.length > 0) {
			add.mutate({ tailnet, machine, path });
		}
	};

	return (
		<div className="space-y-4">
			<SectionHeading
				title={tailnet ? `Machines on ${tailnet}` : "Machines"}
				action={
					<Button
						size="xs"
						variant="ghost"
						disabled={status.isFetching}
						onClick={() => void status.refetch()}
					>
						<RefreshCw /> Refresh
					</Button>
				}
			/>
			{status.isError && <ErrorLine>{String(status.error)}</ErrorLine>}
			<div className="grid grid-cols-2 gap-2">
				{status.data?.machines.map((m) => (
					<MachineButton
						key={m.name}
						machine={m}
						active={machine === m.name}
						onClick={() => {
							setMachine(m.name);
							setPath([]);
						}}
					/>
				))}
			</div>
			{tailnet !== undefined && machine !== null && (
				<FolderBrowser
					tailnet={tailnet}
					machine={machine}
					path={path}
					setPath={setPath}
					onPick={pick}
					picking={add.isPending}
				/>
			)}
			{add.isError && <ErrorLine>{String(add.error)}</ErrorLine>}
		</div>
	);
}
