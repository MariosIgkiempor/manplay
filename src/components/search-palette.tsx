import { useQuery } from "@tanstack/react-query";
import { ListMusic, Music, Tag, User, X } from "lucide-react";
import {
	type ComponentType,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { SearchShell } from "#/components/search-field.tsx";
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
import { searchInputClass } from "#/lib/search-field.ts";
import { focusListRow } from "#/lib/use-list-entry-keys.ts";
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
				className="rounded-md p-0.5 hover:bg-primary/20"
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
	/** A segment at the bar's right end, e.g. how the results are sorted. */
	trailing?: ReactNode;
}

/** Command-palette search: type to filter, or pick artists, songs, playlists and tags as pills. */
export function SearchPalette({ pills, onPills, text, onText, trailing }: Props) {
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
	// With no suggestion showing, Enter goes on to the songs found, to move through with J and K.
	const choose = () => {
		const s = open ? flat[active] : undefined;
		if (s) {
			pick(s);
		} else {
			focusListRow();
		}
		return true;
	};
	// Escape closes the suggestions, then empties the text, then folds the field.
	const onEscape = () => {
		if (open && groups.length > 0) {
			setOpen(false);
		} else if (text !== "") {
			onText("");
		} else {
			input.current?.blur();
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
		<SearchShell
			active={hasAny}
			inputRef={input}
			label="Search this page"
			fieldClassName="relative"
			trailing={trailing && <div className="flex h-full shrink-0 items-stretch">{trailing}</div>}
		>
			{(shown) => (
				<>
					<div
						className={cn(
							"flex h-full min-w-0 items-center gap-1 overflow-x-auto no-scrollbar",
							shown && "flex-1",
						)}
					>
						{pills.map((p) => (
							<PillChip
								key={pillKey(p)}
								pill={p}
								onRemove={() => onPills(pills.filter((x) => pillKey(x) !== pillKey(p)))}
							/>
						))}
						<input
							ref={input}
							data-page-search
							value={text}
							tabIndex={shown ? 0 : -1}
							onChange={(e) => {
								onText(e.target.value);
								setActive(0);
								setOpen(true);
							}}
							onFocus={() => setOpen(true)}
							onBlur={() => setOpen(false)}
							onKeyDown={onKeyDown}
							placeholder={pills.length === 0 ? "Search songs, artists, playlists, tags…" : ""}
							aria-label="Search"
							role="combobox"
							aria-expanded={open}
							aria-controls={listId}
							className={cn(searchInputClass(shown), pills.length > 0 && "min-w-24")}
						/>
					</div>
					{hasAny && (
						<button
							type="button"
							aria-label="Clear search"
							className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
							onMouseDown={(e) => e.preventDefault()}
							onClick={clear}
						>
							<X className="size-4" />
						</button>
					)}
					{open && groups.length > 0 && (
						<SuggestionList
							id={listId}
							groups={groups}
							active={active}
							onActive={setActive}
							onPick={pick}
						/>
					)}
				</>
			)}
		</SearchShell>
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
			className="card-surface absolute top-full right-0 left-0 z-30 mt-1 max-h-80 origin-top animate-in overflow-y-auto p-1 fade-in-0 zoom-in-[0.98] duration-150 motion-reduce:animate-none text-sm"
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
