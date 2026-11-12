import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Smartphone } from "lucide-react";
import { useState } from "react";
import { FolderBrowser } from "#/components/folder-browser.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { addR2Target, addSyncTarget, type Machine, tailscaleStatus } from "#/lib/api.ts";
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
					{machine.online ? "online" : "offline"} · {machine.os}
				</span>
			</span>
		</button>
	);
}

const R2_FIELDS = [
	["account", "Account ID", "text"],
	["bucket", "Bucket", "text"],
	["prefix", "Folder in bucket (optional)", "text"],
	["keyId", "Access Key ID", "text"],
	["secret", "Secret Access Key", "password"],
] as const;

/** Credentials for a Cloudflare R2 bucket. The secret is stored in the OS keychain. */
function AddR2({ onAdded }: { onAdded: () => void }) {
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
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			onAdded();
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
				{R2_FIELDS.map(([key, label, type]) => (
					<div key={key} className="space-y-1.5 text-sm">
						<label htmlFor={`r2-${key}`} className="font-medium text-xs">
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
					</div>
				))}
			</div>
			<Button type="submit" className="w-full" disabled={add.isPending}>
				{add.isPending ? "Checking…" : "Add bucket"}
			</Button>
			{add.isError && <p className="text-destructive text-sm">{String(add.error)}</p>}
		</form>
	);
}

/** Choose where to back up: a Cloudflare R2 bucket or a Tailscale machine. */
export function AddDestination({ onAdded }: { onAdded: () => void }) {
	const [kind, setKind] = useState<"r2" | "tailscale">("r2");
	return (
		<div className="space-y-6 pb-8">
			<div className="space-y-1">
				<h2 className="font-semibold text-2xl tracking-tight">Add destination</h2>
				<p className="text-muted-foreground text-sm">Choose where your library is backed up.</p>
			</div>
			<div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
				{(
					[
						["r2", "Cloudflare R2"],
						["tailscale", "Tailscale"],
					] as const
				).map(([id, label]) => (
					<button
						key={id}
						type="button"
						onClick={() => setKind(id)}
						className={cn(
							"rounded-md px-3 py-1.5 font-medium text-sm transition-colors",
							kind === id
								? "bg-background shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{label}
					</button>
				))}
			</div>
			{kind === "r2" ? <AddR2 onAdded={onAdded} /> : <AddTailscale onAdded={onAdded} />}
		</div>
	);
}

/** Pick a Tailscale machine, browse its Taildrive folders, and add one as a destination. */
function AddTailscale({ onAdded }: { onAdded: () => void }) {
	const queryClient = useQueryClient();
	const [machine, setMachine] = useState<string | null>(null);
	const [path, setPath] = useState<string[]>([]);
	const status = useQuery({ queryKey: ["ts-status"], queryFn: tailscaleStatus });
	const tailnet = status.data?.tailnet;

	const add = useMutation({
		mutationFn: addSyncTarget,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
			onAdded();
		},
	});

	const pick = () => {
		if (tailnet !== undefined && machine !== null && path.length > 0) {
			add.mutate({ tailnet, machine, path });
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="font-medium">Choose a machine {tailnet && `on ${tailnet}`}</h3>
				<button
					type="button"
					className="text-muted-foreground text-xs hover:underline"
					onClick={() => void status.refetch()}
				>
					Refresh
				</button>
			</div>
			{status.isError && <p className="text-destructive text-sm">{String(status.error)}</p>}
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
			{add.isError && <p className="text-destructive text-sm">{String(add.error)}</p>}
		</div>
	);
}
