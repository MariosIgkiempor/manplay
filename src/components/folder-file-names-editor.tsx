import { MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import { ChevronDown } from "lucide-react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { MenuPopup, MenuRoot } from "#/components/ui/popup.tsx";
import type { FolderFileNames, FolderNameTag } from "#/lib/api.ts";
import {
	EXAMPLE_SONG,
	FOLDER_NAME_PRESETS,
	FOLDER_NAME_TAG_LABELS,
	folderNameTokens,
	formatFolderFileName,
	parseFolderFileName,
	renderFolderFileName,
	tagBeingTyped,
	tagsMatching,
	tagToken,
	tokenAt,
} from "#/lib/folder-file-names.ts";
import { cn } from "#/lib/utils.ts";

const menuItem =
	"flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted";

/** Text and the box drawn behind it share these, so each tag's chip sits exactly under its token. */
const fieldText = "px-2.5 text-sm whitespace-pre";

/** The text with each tag token on a chip; in the field, drawn behind its transparent text. */
export function Highlighted({ text }: { text: string }) {
	const out: ReactNode[] = [];
	let at = 0;
	for (const { start, end } of folderNameTokens(text)) {
		out.push(text.slice(at, start));
		out.push(
			<span
				key={start}
				// A shadow, not padding, so the chip is wider than its token without moving the text.
				className="rounded-sm bg-primary/15 text-primary shadow-[0_0_0_2px] shadow-primary/15"
			>
				{text.slice(start, end)}
			</span>,
		);
		at = end;
	}
	out.push(text.slice(at));
	return out;
}

/**
 * How songs in playlist folders are named: one field to type in, tags written as `{Artist}` and
 * shown as chips, with the tags offered below while typing. The position always comes first so
 * players list the songs in playlist order; a preview shows the name an example song gets.
 */
export function FolderFileNamesEditor({
	parts,
	onChange,
}: {
	parts: FolderFileNames;
	onChange: (parts: FolderFileNames) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const anchor = useRef<HTMLDivElement>(null);
	const listId = useId();
	const [text, setText] = useState(() => formatFolderFileName(parts));
	const [caret, setCaret] = useState(0);
	const [scroll, setScroll] = useState(0);
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);

	// A preset or a saved choice replaces what is typed, unless it is what the text already says.
	useEffect(() => {
		setText((current) => {
			const parsed = parseFolderFileName(current);
			const same = parsed.ok && JSON.stringify(parsed.parts) === JSON.stringify(parts);
			return same ? current : formatFolderFileName(parts);
		});
	}, [parts]);

	const parsed = parseFolderFileName(text);
	const typing = tagBeingTyped(text, caret);
	const options = tagsMatching(typing?.query ?? "");
	const showList = open && options.length > 0;
	const preview = `01 ${renderFolderFileName(parsed.ok ? parsed.parts : parts, EXAMPLE_SONG)}`;

	const edit = (next: string, nextCaret: number) => {
		setText(next);
		setCaret(nextCaret);
		setActive(0);
		setOpen(true);
		const result = parseFolderFileName(next);
		if (result.ok) {
			onChange(result.parts);
		}
		requestAnimationFrame(() => input.current?.setSelectionRange(nextCaret, nextCaret));
	};

	const insert = (tag: FolderNameTag) => {
		const token = tagToken(tag);
		const from = typing ? typing.from : caret;
		edit(text.slice(0, from) + token + text.slice(caret), from + token.length);
	};

	/** Backspace or Delete next to a tag removes all of it; true when it did. */
	const removeTag = (event: KeyboardEvent<HTMLInputElement>): boolean => {
		const el = event.currentTarget;
		const side = { Backspace: "before", Delete: "after" } as const;
		const key = event.key as keyof typeof side;
		if (!(key in side) || el.selectionStart !== el.selectionEnd) {
			return false;
		}
		const token = tokenAt(text, el.selectionStart ?? 0, side[key]);
		if (!token) {
			return false;
		}
		event.preventDefault();
		edit(text.slice(0, token.start) + text.slice(token.end), token.start);
		return true;
	};

	/** The arrow keys, Enter, Tab and Escape work the list of tags while it is open. */
	const listKey = (event: KeyboardEvent<HTMLInputElement>) => {
		const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		if (step !== undefined) {
			event.preventDefault();
			setActive((i) => (i + step + options.length) % options.length);
			return;
		}
		const tag = options[active];
		if (tag && (event.key === "Enter" || (event.key === "Tab" && typing))) {
			event.preventDefault();
			insert(tag);
		} else if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (removeTag(event)) {
			return;
		}
		if (showList) {
			listKey(event);
		} else if (event.key === "ArrowDown") {
			setOpen(true);
		}
	};

	const syncCaret = () => {
		const el = input.current;
		if (el) {
			setCaret(el.selectionStart ?? 0);
			setScroll(el.scrollLeft);
		}
	};

	return (
		<fieldset aria-label="File names" className="space-y-1.5">
			<div className="flex items-start gap-2">
				<div ref={anchor} className="relative min-w-0 flex-1">
					<div
						className={cn(
							"flex h-8 items-center rounded-lg border border-input bg-background dark:bg-input/30",
							"focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
							!parsed.ok && "border-destructive",
						)}
					>
						<span
							className="shrink-0 select-none border-r py-1 pr-2 pl-2.5 text-muted-foreground text-sm"
							data-hint="The song's place in the playlist always comes first, so players list the songs in order."
						>
							01
						</span>
						<div className="relative h-full min-w-0 flex-1 overflow-hidden">
							<div
								aria-hidden
								className={cn(
									"pointer-events-none absolute inset-y-0 left-0 flex items-center",
									fieldText,
								)}
								style={{ transform: `translateX(${-scroll}px)` }}
							>
								<Highlighted text={text} />
							</div>
							<input
								ref={input}
								role="combobox"
								aria-label="File name. Type text, and { for a tag."
								aria-expanded={showList}
								aria-controls={listId}
								aria-activedescendant={showList ? `${listId}-${active}` : undefined}
								aria-invalid={!parsed.ok}
								spellCheck={false}
								autoComplete="off"
								value={text}
								onChange={(e) => edit(e.target.value, e.target.selectionStart ?? 0)}
								onKeyDown={onKeyDown}
								onKeyUp={syncCaret}
								onClick={syncCaret}
								onSelect={syncCaret}
								onScroll={syncCaret}
								onFocus={() => setOpen(true)}
								onBlur={() => setOpen(false)}
								className={cn(
									"relative h-full w-full bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/25",
									fieldText,
								)}
							/>
						</div>
					</div>
					{showList && (
						<FloatingList
							anchor={anchor}
							id={listId}
							className="grid min-w-72 grid-cols-3 gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
						>
							{options.map((tag, i) => (
								<div
									key={tag}
									id={`${listId}-${i}`}
									role="option"
									aria-selected={i === active}
									tabIndex={-1}
									// On press, not click, so the caret stays in the field where the tag goes. The
									// field's own keys pick an option (aria-activedescendant).
									onMouseDown={(e) => {
										e.preventDefault();
										insert(tag);
									}}
									onMouseEnter={() => setActive(i)}
									className={cn(
										"cursor-default whitespace-nowrap rounded-md px-2 py-1 text-sm",
										i === active && "bg-muted",
									)}
								>
									{FOLDER_NAME_TAG_LABELS[tag]}
								</div>
							))}
						</FloatingList>
					)}
				</div>
				<MenuRoot>
					<MenuTrigger className="flex h-8 shrink-0 items-center gap-1 rounded-lg border bg-background px-2.5 text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[open]:bg-muted [&_svg]:size-3.5">
						Presets
						<ChevronDown />
					</MenuTrigger>
					<MenuPopup
						sideOffset={4}
						align="end"
						className="w-56 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
					>
						{FOLDER_NAME_PRESETS.map((preset) => (
							<MenuItem
								key={preset.label}
								className={menuItem}
								onSelect={() => {
									onChange(preset.parts);
								}}
							>
								{preset.label}
							</MenuItem>
						))}
					</MenuPopup>
				</MenuRoot>
			</div>

			{parsed.ok ? (
				<p className="truncate text-muted-foreground text-xs">
					Example: <span className="text-foreground">{preview}</span>
				</p>
			) : (
				<p className="text-destructive text-xs">{parsed.error}</p>
			)}
		</fieldset>
	);
}

/** Room kept between the list and the field, and from the window's edge. */
const GAP = 4;

/**
 * The tag list, drawn over everything beside the field it belongs to: in a panel that clips its
 * contents it would otherwise be cut off. Opens below the field, or above it when there is more
 * room there, and follows the field as the page scrolls.
 */
function FloatingList({
	anchor,
	id,
	className,
	children,
}: {
	anchor: RefObject<HTMLElement | null>;
	id: string;
	className: string;
	children: ReactNode;
}) {
	const [box, setBox] = useState<CSSProperties | null>(null);
	useLayoutEffect(() => {
		const place = () => {
			const r = anchor.current?.getBoundingClientRect();
			if (!r) {
				return;
			}
			const below = window.innerHeight - r.bottom;
			setBox(
				below >= r.top || below >= 160
					? { left: r.left, width: r.width, top: r.bottom + GAP }
					: { left: r.left, width: r.width, bottom: window.innerHeight - r.top + GAP },
			);
		};
		place();
		window.addEventListener("resize", place);
		// Any scrolling container, the side panel's included.
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [anchor]);
	if (!box) {
		return null;
	}
	return createPortal(
		<div
			id={id}
			role="listbox"
			aria-label="Tags"
			style={{ ...box, position: "fixed" }}
			className={cn("z-50", className)}
		>
			{children}
		</div>,
		document.body,
	);
}
