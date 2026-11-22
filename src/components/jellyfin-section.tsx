import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, KeyRound, LibraryBig, ListMusic, Server, Unplug, UserRound } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { BrandGlyph } from "#/components/brand-icon.tsx";
import { SettingLabel } from "#/components/destination-header.tsx";
import { JellyfinPlaylistsRow } from "#/components/jellyfin-playlists.tsx";
import { JellyfinPushRow } from "#/components/jellyfin-push.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
	checkJellyfinSongs,
	forgetJellyfin,
	type JellyfinLibraryId,
	type JellyfinServer,
	type JellyfinSettings,
	type JellyfinSongCheck,
	type JellyfinUserId,
	type JellyfinVisibility,
	onJellyfinPush,
	probeJellyfin,
	saveJellyfin,
} from "#/lib/api.ts";
import { normaliseVisibility, sameVisibility, toggleViewer } from "#/lib/jellyfin-visibility.ts";
import { useJellyfinSettings } from "#/lib/queries.ts";

/** A labelled control as a settings row; the label points at the control. */
function Row({
	icon,
	title,
	hint,
	control,
}: {
	icon: ReactNode;
	title: string;
	hint: ReactNode;
	control: (id: string) => ReactNode;
}) {
	const id = useId();
	return (
		<SettingRow
			label={
				<label htmlFor={id}>
					<SettingLabel icon={icon} title={title} hint={hint} />
				</label>
			}
		>
			{control(id)}
		</SettingRow>
	);
}

const SELECT =
	"h-8 w-60 rounded-lg border bg-transparent px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** What is typed and chosen in the form. An empty `apiKey` means the saved one. */
type Draft = {
	url: string;
	apiKey: string;
	userId: JellyfinUserId | null;
	libraryId: JellyfinLibraryId | null;
	visibility: JellyfinVisibility;
};

/** A server's users and libraries, and the address and typed key they were read with. */
type Read = { server: JellyfinServer; url: string; apiKey: string };

/** The choice kept if the server still has it, else the server's first. */
function keepOrFirst<Id extends string>(options: { id: Id }[], current: Id | null): Id | null {
	return options.some((o) => o.id === current) ? current : (options[0]?.id ?? null);
}

/** The server as read for exactly what is typed now; any other read must be redone first. */
function currentRead(read: Read | null, draft: Draft): Read | null {
	if (read === null) {
		return null;
	}
	return read.url === draft.url.trim() && read.apiKey === draft.apiKey.trim() ? read : null;
}

function differsFromSaved(draft: Draft, saved: JellyfinSettings | null): boolean {
	if (saved === null) {
		return true;
	}
	return (
		draft.url.trim() !== saved.url ||
		draft.apiKey.trim() !== "" ||
		draft.userId !== saved.user.id ||
		draft.libraryId !== saved.library.id ||
		!sameVisibility(draft.visibility, saved.visibility, draft.userId)
	);
}

const emptyDraft = (saved: JellyfinSettings | null): Draft => ({
	url: saved?.url ?? "",
	apiKey: "",
	userId: saved?.user.id ?? null,
	libraryId: saved?.library.id ?? null,
	visibility: saved?.visibility ?? { kind: "onlyMe" },
});

function useJellyfinForm(targetId: number, saved: JellyfinSettings | null) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<Draft>(() => emptyDraft(saved));
	const [connected, setConnected] = useState<Read | null>(null);
	const edit = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));

	// A saved server is read with the saved key, so its user and library can be changed.
	const savedUrl = saved?.url ?? "";
	const savedServer = useQuery({
		queryKey: ["jellyfin-server", targetId, savedUrl],
		queryFn: () => probeJellyfin({ targetId, url: savedUrl }),
		enabled: saved !== null,
		retry: false,
	});
	const fromSaved = savedServer.data
		? { server: savedServer.data, url: savedUrl, apiKey: "" }
		: null;

	const connect = useMutation({
		mutationFn: probeJellyfin,
		onSuccess: (found, sent) => {
			setConnected({ server: found, url: sent.url, apiKey: sent.apiKey ?? "" });
			setDraft((d) => ({
				...d,
				userId: keepOrFirst(found.users, d.userId),
				libraryId: keepOrFirst(found.libraries, d.libraryId),
			}));
		},
	});
	const save = useMutation({
		mutationFn: saveJellyfin,
		onSuccess: (settings) => {
			setConnected(null);
			setDraft(emptyDraft(settings));
			queryClient.setQueryData(["jellyfin", targetId], settings);
			void queryClient.invalidateQueries({ queryKey: ["jellyfin-destinations"] });
		},
	});
	const forget = useMutation({
		mutationFn: forgetJellyfin,
		onSuccess: async () => {
			setConnected(null);
			setDraft(emptyDraft(null));
			await queryClient.invalidateQueries({ queryKey: ["jellyfin", targetId] });
			await queryClient.invalidateQueries({ queryKey: ["jellyfin-destinations"] });
		},
	});

	const read = currentRead(connected ?? fromSaved, draft);
	const url = draft.url.trim();
	const apiKey = draft.apiKey.trim() || undefined;
	const canConnect = url !== "" && (apiKey !== undefined || saved !== null);
	const { userId, libraryId } = draft;
	const visibility = normaliseVisibility(draft.visibility, userId);
	const canSave =
		read !== null && userId !== null && libraryId !== null && differsFromSaved(draft, saved);
	const submit = () => {
		if (read === null && canConnect) {
			connect.mutate({ targetId, url, apiKey });
		} else if (canSave) {
			save.mutate({ targetId, url, apiKey, userId, libraryId, visibility });
		}
	};

	return {
		draft,
		edit,
		read,
		canConnect,
		canSave,
		submit,
		connect,
		save,
		forget,
		busy: connect.isPending || save.isPending || forget.isPending,
		error: connect.error ?? save.error ?? forget.error ?? savedServer.error,
	};
}

type Form = ReturnType<typeof useJellyfinForm>;

function Actions({ form, targetId, saved }: { form: Form; targetId: number; saved: boolean }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			{form.read ? (
				<Button type="submit" size="sm" disabled={!form.canSave || form.busy}>
					{form.save.isPending ? "Saving…" : "Save"}
				</Button>
			) : (
				<Button type="submit" size="sm" disabled={!form.canConnect || form.busy}>
					{form.connect.isPending ? "Connecting…" : "Connect"}
				</Button>
			)}
			{saved && (
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={form.busy}
					onClick={() => form.forget.mutate(targetId)}
				>
					<Unplug /> Disconnect
				</Button>
			)}
		</div>
	);
}

const VISIBILITY_LABELS: Record<JellyfinVisibility["kind"], string> = {
	onlyMe: "Only this user",
	everyone: "Everyone on the server",
	users: "These users",
};

function visibilityOf(kind: string, current: JellyfinVisibility): JellyfinVisibility {
	if (kind === "everyone") {
		return { kind: "everyone" };
	}
	if (kind === "users") {
		return current.kind === "users" ? current : { kind: "users", users: [] };
	}
	return { kind: "onlyMe" };
}

/** Who sees the playlists besides their owner, and for "These users", which ones. */
function VisibilityRows({
	server,
	draft,
	edit,
}: {
	server: JellyfinServer;
	draft: Draft;
	edit: (change: Partial<Draft>) => void;
}) {
	const others = server.users.filter((u) => u.id !== draft.userId);
	const ticked = draft.visibility.kind === "users" ? draft.visibility.users : [];
	return (
		<>
			<Row
				icon={<Eye />}
				title="Visible to"
				hint="Playlists already sent are made again when this changes, after a review."
				control={(id) => (
					<select
						id={id}
						className={SELECT}
						value={draft.visibility.kind}
						onChange={(e) => edit({ visibility: visibilityOf(e.target.value, draft.visibility) })}
					>
						{Object.entries(VISIBILITY_LABELS).map(([kind, label]) => (
							<option key={kind} value={kind}>
								{label}
							</option>
						))}
					</select>
				)}
			/>
			{draft.visibility.kind === "users" && (
				<fieldset className="space-y-1 py-2">
					<legend className="sr-only">Users who see the playlists</legend>
					{others.length === 0 && (
						<p className="text-muted-foreground text-sm">The server has no other users.</p>
					)}
					{others.map((u) => (
						<label key={u.id} className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={ticked.includes(u.id)}
								onChange={() => edit({ visibility: toggleViewer(draft.visibility, u.id) })}
							/>
							{u.name}
							<span className="text-muted-foreground text-xs">can play, not edit</span>
						</label>
					))}
				</fieldset>
			)}
		</>
	);
}

function ChoiceRows({
	server,
	draft,
	edit,
}: {
	server: JellyfinServer;
	draft: Draft;
	edit: (change: Partial<Draft>) => void;
}) {
	return (
		<>
			<Row
				icon={<UserRound />}
				title="Jellyfin user"
				hint="Playlists are made for this user."
				control={(id) => (
					<select
						id={id}
						className={SELECT}
						value={draft.userId ?? ""}
						onChange={(e) =>
							edit({ userId: server.users.find((u) => u.id === e.target.value)?.id ?? null })
						}
					>
						{server.users.map((u) => (
							<option key={u.id} value={u.id}>
								{u.name}
							</option>
						))}
					</select>
				)}
			/>
			<Row
				icon={<LibraryBig />}
				title="Library"
				hint="The Jellyfin library that scans this destination."
				control={(id) =>
					server.libraries.length === 0 ? (
						<span className="text-muted-foreground text-sm">No music libraries</span>
					) : (
						<select
							id={id}
							className={SELECT}
							value={draft.libraryId ?? ""}
							onChange={(e) =>
								edit({
									libraryId: server.libraries.find((l) => l.id === e.target.value)?.id ?? null,
								})
							}
						>
							{server.libraries.map((l) => (
								<option key={l.id} value={l.id} title={l.locations.join("\n")}>
									{l.name}
								</option>
							))}
						</select>
					)
				}
			/>
		</>
	);
}

function JellyfinForm({
	targetId,
	saved,
	about,
}: {
	targetId: number;
	saved: JellyfinSettings | null;
	/** What is connected, or what connecting does; under the group's name. */
	about: string;
}) {
	const form = useJellyfinForm(targetId, saved);
	const { draft, read } = form;

	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				form.submit();
			}}
		>
			<SettingRows title="Jellyfin" icon={<BrandGlyph brand="jellyfin" />} description={about}>
				<Row
					icon={<Server />}
					title="Server address"
					hint={
						read
							? `${read.server.name} · Jellyfin ${read.server.version}`
							: "Where Jellyfin runs, e.g. http://nas:8096"
					}
					control={(id) => (
						<Input
							id={id}
							className="w-60"
							autoComplete="off"
							spellCheck={false}
							placeholder="http://nas:8096"
							value={draft.url}
							onChange={(e) => form.edit({ url: e.target.value })}
						/>
					)}
				/>
				<Row
					icon={<KeyRound />}
					title="API key"
					hint="Make one in Jellyfin under Dashboard → API Keys. Kept in the keychain."
					control={(id) => (
						<Input
							id={id}
							type="password"
							className="w-60"
							autoComplete="off"
							placeholder={saved ? "Unchanged" : ""}
							value={draft.apiKey}
							onChange={(e) => form.edit({ apiKey: e.target.value })}
						/>
					)}
				/>
				{read && <ChoiceRows server={read.server} draft={draft} edit={form.edit} />}
				{read && <VisibilityRows server={read.server} draft={draft} edit={form.edit} />}
			</SettingRows>
			<Actions form={form} targetId={targetId} saved={saved !== null} />
			{form.error && <ErrorLine>{String(form.error)}</ErrorLine>}
		</form>
	);
}

function songCheckText(check: JellyfinSongCheck): string {
	const found = `${check.found.toLocaleString()} of ${check.synced.toLocaleString()} synced songs are in Jellyfin.`;
	const parts = [found];
	if (check.missing > 0) {
		parts.push(
			`${check.missing.toLocaleString()} not found: not scanned yet, or outside this library.`,
		);
	}
	if (check.ambiguous > 0) {
		parts.push(`${check.ambiguous.toLocaleString()} found more than once, so left out.`);
	}
	return parts.join(" ");
}

/** Matches the destination's synced songs to Jellyfin's, to see playlists will be complete. */
function SongCheck({ targetId }: { targetId: number }) {
	const check = useMutation({ mutationFn: checkJellyfinSongs });
	return (
		<SettingRows title="Playlists in Jellyfin" icon={<BrandGlyph brand="jellyfin" />}>
			<JellyfinPlaylistsRow targetId={targetId} />
			<JellyfinPushRow targetId={targetId} />
			<SettingRow
				label={
					<SettingLabel
						icon={<ListMusic />}
						title="Songs in Jellyfin"
						hint={
							check.data
								? songCheckText(check.data)
								: "Finds each synced song in Jellyfin, as playlists will."
						}
					/>
				}
			>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={check.isPending}
					onClick={() => check.mutate(targetId)}
				>
					{check.isPending ? "Checking…" : "Check songs"}
				</Button>
			</SettingRow>
			{check.data && check.data.examples.length > 0 && (
				<ul className="space-y-0.5 py-2 font-mono text-muted-foreground text-xs">
					{check.data.examples.map((rel) => (
						<li key={rel} className="truncate" title={rel}>
							{rel}
						</li>
					))}
				</ul>
			)}
			{check.error && <ErrorLine>{String(check.error)}</ErrorLine>}
		</SettingRows>
	);
}

/** The Jellyfin server that scans this destination, where its playlists will be sent. */
export function JellyfinSection({ targetId }: { targetId: number }) {
	const settings = useJellyfinSettings(targetId);
	const queryClient = useQueryClient();
	// A push after a sync runs in the background; show what it did when it ends.
	useEffect(() => {
		const stop = onJellyfinPush((pushed) => {
			if (pushed === targetId) {
				void queryClient.invalidateQueries({ queryKey: ["jellyfin-destinations"] });
				void queryClient.invalidateQueries({ queryKey: ["jellyfin-server-playlists", targetId] });
			}
		});
		return () => {
			void stop.then((unlisten) => unlisten());
		};
	}, [queryClient, targetId]);
	if (settings.isPending) {
		return null;
	}
	const saved = settings.data ?? null;
	return (
		<section aria-label="Jellyfin" className="space-y-3">
			<JellyfinForm
				key={saved ? "saved" : "new"}
				targetId={targetId}
				saved={saved}
				about={
					saved
						? `Connected to ${saved.serverName} as ${saved.user.name}, library ${saved.library.name}.`
						: "Connect the Jellyfin server that plays this destination, to send it playlists."
				}
			/>
			{saved && <SongCheck targetId={targetId} />}
		</section>
	);
}
