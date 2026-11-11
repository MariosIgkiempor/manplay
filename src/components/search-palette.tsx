import { useQuery } from "@tanstack/react-query";
import { ListMusic, Music, Search, Tag, User, X } from "lucide-react";
import {
	type ComponentType,
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { listPlaylists, listTags } from "#/lib/api.ts";
import { useTracks } from "#/lib/queries.ts";
import {
	type Pill,
	type PillKind,
	pillKey,
	type Suggestion,
	type SuggestionGroup,
	suggest,
} from "#/lib/search.ts";
import { cn } from "#/lib/utils.ts";

const ICONS: Record<PillKind, ComponentType<{ className?: string | undefined }>> = {
	artist: User,
	song: Music,
	playlist: ListMusic,
	tag: Tag,
};

function KindIcon({ kind, className }: { kind: PillKind; className?: string | undefined }) {
	const Icon = ICONS[kind];
	return <Icon className={className} />;
}

function PillChip({ pill, onRemove }: { pill: Pill; onRemove: () => void }) {
	return (
		<span className="flex max-w-48 shrink-0 items-center gap-1 rounded-md bg-primary/15 py-0.5 pr-0.5 pl-1.5 text-primary text-xs">
			<KindIcon kind={pill.kind} className="size-3 shrink-0" />
			<span className="truncate">{pill.label}</span>
			<button
				type="button"
				aria-label={`Remove ${pill.label}`}
				className="rounded p-0.5 hover:bg-primary/20"
				onMouseDown={(e) => e.preventDefault()}
				onClick={onRemove}
			>
				<X className="size-3" />
			</button>
		</span>
	);
}

interface Props {
	pills: Pill[];
	onPills: (pills: Pill[]) => void;
	text: string;
	onText: (text: string) => void;
}

/** Command-palette search: type to filter, or pick artists, songs, playlists and tags as pills. */
export function SearchPalette({ pills, onPills, text, onText }: Props) {
	const tracks = useTracks();
	const playlists = useQuery({ queryKey: ["playlists"], queryFn: listPlaylists });
	const tags = useQuery({ queryKey: ["tags"], queryFn: listTags });
	const listId = useId();
	const input = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);

	const groups = useMemo(
		() => suggest(text, tracks.data ?? [], playlists.data ?? [], tags.data ?? [], pills),
		[text, tracks.data, playlists.data, tags.data, pills],
	);
	const flat: Suggestion[] = groups.flatMap((g) => g.items);

	// ⌘K / Ctrl+K jumps to the search bar from anywhere.
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				input.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const pick = (s: Suggestion) => {
		onPills([...pills, s.pill]);
		onText("");
		setActive(0);
	};
	const clear = () => {
		onPills([]);
		onText("");
	};

	const move = (step: number) =>
		setActive((i) => (flat.length === 0 ? 0 : (i + step + flat.length) % flat.length));

	// Handlers return true when they consumed the key (so its default action is suppressed).
	const goDown = () => {
		setOpen(true);
		move(1);
		return true;
	};
	const goUp = () => {
		setOpen(true);
		move(-1);
		return true;
	};
	const choose = () => {
		const s = flat[active];
		if (s) {
			pick(s);
		}
		return true;
	};
	const onEscape = () => {
		if (open) {
			setOpen(false);
		} else {
			onText("");
		}
		return true;
	};
	const backspace = () => {
		if (text === "" && pills.length > 0) {
			onPills(pills.slice(0, -1));
		}
		return false;
	};
	const keys = new Map<string, () => boolean>([
		["ArrowDown", goDown],
		["ArrowUp", goUp],
		["Enter", choose],
		["Escape", onEscape],
		["Backspace", backspace],
	]);

	const onKeyDown = (e: KeyboardEvent) => {
		if (keys.get(e.key)?.()) {
			e.preventDefault();
		}
	};

	const hasAny = text !== "" || pills.length > 0;
	return (
		<div className="relative min-w-40 flex-1">
			<label
				className={cn(
					"flex h-8 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 dark:bg-input/30",
					open && "border-ring ring-3 ring-ring/50",
				)}
			>
				<Search className="size-4 shrink-0 text-muted-foreground" />
				<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
					{pills.map((p) => (
						<PillChip
							key={pillKey(p)}
							pill={p}
							onRemove={() => onPills(pills.filter((x) => pillKey(x) !== pillKey(p)))}
						/>
					))}
					<input
						ref={input}
						value={text}
						onChange={(e) => {
							onText(e.target.value);
							setActive(0);
							setOpen(true);
						}}
						onFocus={() => setOpen(true)}
						onBlur={() => setOpen(false)}
						onKeyDown={onKeyDown}
						placeholder={pills.length === 0 ? "Search songs, artists, playlists, tags…  ⌘K" : ""}
						aria-label="Search"
						role="combobox"
						aria-expanded={open}
						aria-controls={listId}
						className="h-full min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					/>
				</div>
				{hasAny && (
					<button
						type="button"
						aria-label="Clear search"
						className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
						onMouseDown={(e) => e.preventDefault()}
						onClick={clear}
					>
						<X className="size-4" />
					</button>
				)}
			</label>
			{open && groups.length > 0 && (
				<SuggestionList
					id={listId}
					groups={groups}
					active={active}
					onActive={setActive}
					onPick={pick}
				/>
			)}
		</div>
	);
}

function SuggestionList({
	id,
	groups,
	active,
	onActive,
	onPick,
}: {
	id: string;
	groups: SuggestionGroup[];
	active: number;
	onActive: (i: number) => void;
	onPick: (s: Suggestion) => void;
}) {
	let index = -1;
	return (
		<div
			id={id}
			role="listbox"
			className="absolute top-full right-0 left-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground text-sm shadow-lg"
		>
			{groups.map((g) => (
				<div key={g.title}>
					<div className="px-2 pt-1.5 pb-0.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
						{g.title}
					</div>
					{g.items.map((s) => {
						index += 1;
						const i = index;
						return (
							// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the input
							<div
								key={pillKey(s.pill)}
								role="option"
								tabIndex={-1}
								aria-selected={i === active}
								className={cn(
									"flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
									i === active && "bg-muted",
								)}
								onMouseEnter={() => onActive(i)}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => onPick(s)}
							>
								<KindIcon kind={s.pill.kind} className="size-4 shrink-0 text-muted-foreground" />
								<span className="flex-1 truncate">{s.pill.label}</span>
								<span className="truncate text-muted-foreground text-xs">{s.hint}</span>
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}
