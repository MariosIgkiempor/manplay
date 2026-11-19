import { useMutation, useQuery } from "@tanstack/react-query";
import { EyeOff, Lock, TriangleAlert, Users } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { RowMenu } from "#/components/menu.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { CHILD_PAD, rowBase } from "#/components/sidebar-row.ts";
import { StatusIcon } from "#/components/status-icon.tsx";
import {
	type ItemKind,
	type LocalTagUse,
	makePrivate,
	privatePreview,
	type Scope,
	shareItem,
	sharePreview,
	type TagChoice,
} from "#/lib/api.ts";
import { useDefaultScope, useSharingOn } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** What an item's menu needs to know about it. */
export interface Shareable {
	kind: ItemKind;
	id: number;
	name: string;
	scope: Scope;
}

const KIND_WORD: Record<ItemKind, string> = {
	tag: "tag",
	playlist: "playlist",
	smart_playlist: "smart playlist",
};

const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

/**
 * A small mark after an item's name: a warning when it waits in Clashes, else its scope only
 * where it differs from new items' (most items share the default, so marking them all is noise).
 * Scope shows only while some destination shares library data.
 */
export function ScopeMark({ scope, held }: { scope: Scope; held: boolean }) {
	const sharing = useSharingOn();
	const usual = useDefaultScope().scope.data ?? "shared";
	if (held) {
		return (
			<StatusIcon
				focusable={false}
				icon={<TriangleAlert className="text-warning" />}
				label="Name clash"
				detail="Another item has the same name. Settle it in Clashes."
			/>
		);
	}
	if (!sharing || scope === usual) {
		return null;
	}
	return scope === "local" ? (
		<StatusIcon
			focusable={false}
			icon={<Lock />}
			label="Only on this device"
			detail="Not shared with the other devices on the destination."
		/>
	) : (
		<StatusIcon
			focusable={false}
			icon={<Users />}
			label="Shared"
			detail="Everyone on the destination has it."
		/>
	);
}

const SCOPE_OPTIONS = [
	{ value: "shared", label: "Shared", hint: "Shared with the library", icon: <Users /> },
	{ value: "local", label: "Private", hint: "Only on this device", icon: <Lock /> },
] as const;

/**
 * Shared or private, side by side, with the current one lit. `compact` drops the words, for the
 * sidebar's new-item row. Choosing the other side calls `onChange`; the caller decides whether that
 * needs a confirm.
 */
export function ScopeSwitch({
	value,
	onChange,
	compact = false,
	disabled = false,
}: {
	value: Scope;
	onChange: (next: Scope) => void;
	compact?: boolean;
	disabled?: boolean;
}) {
	return (
		<fieldset
			aria-label="Who has it"
			className={cn(
				"m-0 inline-flex min-w-0 shrink-0 items-center rounded-lg border border-border bg-background p-0.5 dark:border-input dark:bg-input/30",
				compact ? "h-6" : "h-8",
			)}
		>
			{SCOPE_OPTIONS.map((o) => {
				const on = value === o.value;
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={on}
						aria-label={compact ? o.hint : undefined}
						title={o.hint}
						disabled={disabled}
						// Keeps focus where it was, so the new-item row's name field stays open.
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => !on && onChange(o.value)}
						className={cn(
							"inline-flex h-full items-center gap-1.5 rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 [&_svg]:shrink-0",
							compact ? "px-1.5 [&_svg]:size-3" : "px-2.5 text-sm [&_svg]:size-3.5",
							on
								? o.value === "shared"
									? "bg-primary/15 text-primary"
									: "bg-muted text-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{o.icon}
						{!compact && o.label}
					</button>
				);
			})}
		</fieldset>
	);
}

/** One choice per local tag a smart playlist uses. */
function TagChoices({
	tags,
	choices,
	onChoose,
}: {
	tags: readonly LocalTagUse[];
	choices: Record<string, TagChoice>;
	onChoose: (tag: string, choice: TagChoice) => void;
}) {
	return (
		<ul className="mt-2 space-y-2">
			{tags.map((t) => (
				<li key={t.tag} className="rounded-md border p-2 text-foreground">
					<div className="font-medium text-sm">
						{t.tag} <span className="font-normal text-muted-foreground">({songs(t.songs)})</span>
					</div>
					<div className="mt-1 flex gap-4 text-sm">
						{(["share", "remove"] as const).map((c) => (
							<label key={c} className="flex items-center gap-1.5">
								<input
									type="radio"
									name={`choice-${t.tag}`}
									checked={choices[t.tag] === c}
									onChange={() => onChoose(t.tag, c)}
								/>
								{c === "share" ? "Share tag too" : "Remove rule"}
							</label>
						))}
					</div>
				</li>
			))}
		</ul>
	);
}

/**
 * The dialog for a smart playlist that would be shared while its rules use local tags: each tag
 * is shared along or dropped from the rules, or the whole thing is cancelled.
 */
export function LocalTagsDialog({
	title,
	tags,
	confirmLabel,
	busy,
	onCancel,
	onConfirm,
}: {
	title: string;
	tags: readonly LocalTagUse[];
	confirmLabel: string;
	busy?: boolean;
	onCancel: () => void;
	onConfirm: (choices: Record<string, TagChoice>) => void;
}) {
	const [choices, setChoices] = useState<Record<string, TagChoice>>({});
	const complete = tags.every((t) => choices[t.tag]);
	const shared = tags.filter((t) => choices[t.tag] === "share");
	return (
		<ConfirmDialog
			title={title}
			confirmLabel={confirmLabel}
			busy={(busy ?? false) || !complete}
			onCancel={onCancel}
			onConfirm={() => onConfirm(choices)}
		>
			Other devices cannot see local tags. Choose what happens to each one used by the rules.
			<TagChoices
				tags={tags}
				choices={choices}
				onChoose={(t, c) => setChoices((m) => ({ ...m, [t]: c }))}
			/>
			{shared.length > 0 && (
				<p className="mt-2">
					Sharing {shared.map((t) => `“${t.tag}”`).join(", ")} shows{" "}
					{songs(shared.reduce((n, t) => n + t.songs, 0))} with it to everyone.
				</p>
			)}
		</ConfirmDialog>
	);
}

export function ShareDialog({
	item,
	onClose,
	onDone,
}: {
	item: Shareable;
	onClose: () => void;
	onDone: () => Promise<void>;
}) {
	const preview = useQuery({
		queryKey: ["share-preview", item.kind, item.id],
		queryFn: () => sharePreview(item.kind, item.id),
		gcTime: 0,
	});
	const share = useMutation({
		mutationFn: (tags: Record<string, TagChoice>) => shareItem(item.kind, item.id, tags),
		onSuccess: async () => {
			await onDone();
			onClose();
		},
	});
	const data = preview.data;
	if (!data) {
		return preview.isError ? (
			<ConfirmDialog
				title="Could not read it"
				confirmLabel="Close"
				onCancel={onClose}
				onConfirm={onClose}
			>
				{String(preview.error)}
			</ConfirmDialog>
		) : null;
	}
	const error = share.isError ? (
		<ErrorLine className="mt-2">{String(share.error)}</ErrorLine>
	) : null;
	if (data.localTags.length > 0) {
		return (
			<LocalTagsDialog
				title={`Share smart playlist “${data.name}”?`}
				tags={data.localTags}
				confirmLabel="Share smart playlist"
				busy={share.isPending}
				onCancel={onClose}
				onConfirm={(choices) => share.mutate(choices)}
			/>
		);
	}
	return (
		<ConfirmDialog
			title={`Share ${KIND_WORD[item.kind]} “${data.name}”?`}
			confirmLabel="Share"
			busy={share.isPending}
			onCancel={onClose}
			onConfirm={() => share.mutate({})}
		>
			{item.kind === "smart_playlist"
				? "Everyone on the destination gets its rules."
				: `Everyone on the destination gets it${data.songs > 0 ? `, and it shows ${songs(data.songs)} to them` : ""}. They can change it, and changes come back to you.`}
			{error}
		</ConfirmDialog>
	);
}

export function PrivateDialog({
	item,
	onClose,
	onDone,
}: {
	item: Shareable;
	onClose: () => void;
	onDone: () => Promise<void>;
}) {
	const preview = useQuery({
		queryKey: ["private-preview", item.kind, item.id],
		queryFn: () => privatePreview(item.kind, item.id),
		gcTime: 0,
	});
	const priv = useMutation({
		mutationFn: (removeRules: boolean) => makePrivate(item.kind, item.id, removeRules),
		onSuccess: async () => {
			await onDone();
			onClose();
		},
	});
	const data = preview.data;
	if (!data) {
		return preview.isError ? (
			<ConfirmDialog
				title="Could not read it"
				confirmLabel="Close"
				onCancel={onClose}
				onConfirm={onClose}
			>
				{String(preview.error)}
			</ConfirmDialog>
		) : null;
	}
	return (
		<ConfirmDialog
			title={`Make ${KIND_WORD[item.kind]} “${data.name}” private?`}
			confirmLabel="Make private"
			destructive
			busy={priv.isPending}
			onCancel={onClose}
			onConfirm={() => priv.mutate(data.usedBy.length > 0)}
		>
			This removes it for everyone else. You keep a copy that stays on this device.
			{data.usedBy.length > 0 && (
				<p className="mt-2">
					The shared smart {data.usedBy.length === 1 ? "playlist" : "playlists"}{" "}
					{data.usedBy.map((n) => `“${n}”`).join(", ")} use it: the rule is removed from{" "}
					{data.usedBy.length === 1 ? "it" : "them"}.
				</p>
			)}
			{priv.isError && <ErrorLine className="mt-2">{String(priv.error)}</ErrorLine>}
		</ConfirmDialog>
	);
}

/**
 * Items hidden on this device, folded under a group: one line to open the list, and each item's
 * menu brings it back.
 */
export function HiddenItems({
	items,
	onUnhide,
}: {
	items: readonly { key: string; name: string; item: Shareable }[];
	onUnhide: (item: Shareable) => void;
}) {
	const [open, setOpen] = useState(false);
	if (items.length === 0) {
		return null;
	}
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className={cn(rowBase, "text-left text-xs outline-none")}
				style={{ paddingLeft: CHILD_PAD }}
			>
				<EyeOff className="size-3.5 shrink-0" />
				{items.length} hidden
			</button>
			{open &&
				items.map((h) => (
					<RowMenu
						key={h.key}
						label={h.name}
						items={[{ label: "Unhide", icon: <EyeOff />, onSelect: () => onUnhide(h.item) }]}
					>
						<div
							className={cn(rowBase, "pr-2 text-xs opacity-70")}
							style={{ paddingLeft: CHILD_PAD + 14 }}
						>
							<span className="truncate">{h.name}</span>
						</div>
					</RowMenu>
				))}
		</div>
	);
}
