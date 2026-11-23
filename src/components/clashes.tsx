import { useMutation, useQuery } from "@tanstack/react-query";
import { ListMusic, Sparkles, Tag, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { InlineInput } from "#/components/inline-edit.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { type Clash, clashCombinePreview, type ItemKind, resolveClash } from "#/lib/api.ts";
import { useClashes, useRefreshItems } from "#/lib/queries.ts";

const KIND: Record<ItemKind, { label: string; icon: ReactNode }> = {
	tag: { label: "Tag", icon: <Tag /> },
	playlist: { label: "Playlist", icon: <ListMusic /> },
	smart_playlist: { label: "Smart playlist", icon: <Sparkles /> },
};

const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

type Side = Clash["keeps"];

/** "Yours" for an item that is only here, "Shared" for one everyone has. */
function describe(side: Side, kind: ItemKind): string {
	const owner = side.scope === "local" ? "Yours, only on this device" : "Shared";
	return kind === "smart_playlist" ? owner : `${owner}, ${songs(side.songs)}`;
}

function renameLabel(side: Side): string {
	return side.scope === "local" ? "Rename mine" : "Rename shared";
}

/** What combining does, in words, before anything is sent. */
function CombineDialog({
	clash,
	onClose,
	onDone,
}: {
	clash: Clash;
	onClose: () => void;
	onDone: () => Promise<void>;
}) {
	const preview = useQuery({
		queryKey: ["clash-combine", clash.id],
		queryFn: () => clashCombinePreview(clash.id),
		gcTime: 0,
	});
	const combine = useMutation({
		mutationFn: () => resolveClash(clash.id, "combine"),
		onSuccess: async () => {
			await onDone();
			onClose();
		},
	});
	const data = preview.data;
	if (!data) {
		return null;
	}
	const word = KIND[clash.kind].label.toLowerCase();
	return (
		<ConfirmDialog
			title={`Combine the two “${clash.name}”?`}
			confirmLabel="Combine"
			busy={combine.isPending}
			onCancel={onClose}
			onConfirm={() => combine.mutate()}
		>
			{data.sharesLocal
				? clash.kind === "smart_playlist"
					? "Your local smart playlist is replaced by the shared one and its rules."
					: `${songs(data.songs)} from your local ${word} become visible to everyone on the destination. The shared ${word} keeps the name and your local one goes away.`
				: `The two ${word}s become one for everyone on the destination, with the songs of both.`}
			{combine.isError && <ErrorLine className="mt-2">{String(combine.error)}</ErrorLine>}
		</ConfirmDialog>
	);
}

function SideLine({
	clash,
	side,
	which,
	renaming,
	onRename,
	onSubmit,
	onCancel,
}: {
	clash: Clash;
	side: Side;
	which: "keeps" | "held";
	renaming: boolean;
	onRename: () => void;
	onSubmit: (name: string) => void;
	onCancel: () => void;
}) {
	return (
		<div className="flex min-h-7 items-center gap-2 text-sm">
			{renaming ? (
				<InlineInput
					initial={clash.name}
					label={`New name for ${side.name}`}
					parse={(v) => v.trim() || null}
					onCommit={onSubmit}
					onCancel={onCancel}
				/>
			) : (
				<>
					<span className="min-w-0 flex-1 truncate text-muted-foreground">
						{describe(side, clash.kind)}
						{which === "held" && <span className="text-warning"> · shown as “{side.name}”</span>}
					</span>
					<Button size="xs" variant="outline" onClick={onRename}>
						{renameLabel(side)}
					</Button>
				</>
			)}
		</div>
	);
}

function ClashRow({ clash, onDone }: { clash: Clash; onDone: () => Promise<void> }) {
	const [combining, setCombining] = useState(false);
	const [renaming, setRenaming] = useState<"keeps" | "held" | null>(null);
	const rename = useMutation({
		mutationFn: ({ side, name }: { side: "keeps" | "held"; name: string }) =>
			resolveClash(clash.id, side === "keeps" ? "renameKeeps" : "renameHeld", name),
		onSuccess: onDone,
	});
	const kind = KIND[clash.kind];
	return (
		<li className="space-y-1 border-b px-[var(--diff-inset)] py-3">
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground [&_svg]:size-4">{kind.icon}</span>
				<span className="min-w-0 flex-1 truncate font-medium text-sm">{clash.name}</span>
				<Button size="xs" onClick={() => setCombining(true)}>
					Combine
				</Button>
			</div>
			{(["keeps", "held"] as const).map((which) => (
				<SideLine
					key={which}
					clash={clash}
					side={clash[which]}
					which={which}
					renaming={renaming === which}
					onRename={() => setRenaming(which)}
					onCancel={() => setRenaming(null)}
					onSubmit={(name) => {
						setRenaming(null);
						rename.mutate({ side: which, name });
					}}
				/>
			))}
			{rename.isError && <ErrorLine>{String(rename.error)}</ErrorLine>}
			{combining && (
				<CombineDialog clash={clash} onClose={() => setCombining(false)} onDone={onDone} />
			)}
		</li>
	);
}

/**
 * Items with the same name on two sides (yours and a shared one, or shared by two devices at
 * once). Until settled both show in the sidebar, the shared one under a held name.
 */
export function ClashList() {
	const clashes = useClashes();
	const refresh = useRefreshItems();
	const list = clashes.data ?? [];
	if (list.length === 0) {
		return null;
	}
	return (
		<section aria-label="Clashes" className="border-b">
			<div className="flex items-center gap-2 px-[var(--diff-inset)] pt-3 pb-1">
				<TriangleAlert className="size-4 text-warning" />
				<h3 className="font-medium text-sm">Clashes</h3>
				<span className="rounded-full bg-warning/15 px-1.5 text-warning text-xs tabular-nums">
					{list.length}
				</span>
			</div>
			<p className="px-[var(--diff-inset)] pb-1 text-muted-foreground text-sm">
				Two items have the same name. Combine them, or rename one.
			</p>
			<ul>
				{list.map((c) => (
					<ClashRow key={c.id} clash={c} onDone={refresh} />
				))}
			</ul>
		</section>
	);
}
