import { Popover, PopoverTrigger } from "@ui-sdk/react/popover";
import { ImagePlus, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type CoverAlbum, CoverCard } from "#/components/cover-card.tsx";
import { SaveState } from "#/components/save-state.tsx";
import { PopoverPopup } from "#/components/ui/popup.tsx";
import { bumpArt } from "#/lib/art-version.ts";
import { COVER_TYPES } from "#/lib/cover-choice.ts";
import { isPickOpen } from "#/lib/file-picker.ts";
import { keyLabel } from "#/lib/platform.ts";
import { useTagsSetCover } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

/** The card's side, in pixels: `size-60`. */
const COVER_CARD_PX = 240;

/**
 * Cover art you can replace. Click it and it grows into a card with the cover large and two
 * buttons on it: upload a picture, or download one found online. ⌘V with a picture copied
 * replaces the cover straight away; the status bar says "Saving…", then "Saved".
 */
export function CoverPicker({
	paths,
	name,
	album,
	children,
	className,
}: {
	/** The song, or every song the cover goes to. */
	paths: string | readonly string[];
	/** What the cover belongs to, for its label. */
	name: string;
	/** The album of the one song in `paths`, when it has others: the card asks which to cover. */
	album?: CoverAlbum | undefined;
	children: ReactNode;
	className?: string;
}) {
	const setCover = useTagsSetCover();
	const [open, setOpen] = useState(false);
	const openRef = useRef(open);
	openRef.current = open;
	const [error, setError] = useState<string | null>(null);
	// A picture pasted onto a song of an album, shown in the card to ask which songs get it.
	const [pasted, setPasted] = useState<Blob | null>(null);

	const apply = async (file: Blob | null | undefined) => {
		if (!file) {
			return;
		}
		if (!COVER_TYPES.includes(file.type)) {
			setError("Use a JPEG or PNG image");
			return;
		}
		setError(null);
		if (album) {
			setPasted(file);
			setOpen(true);
			return;
		}
		const image = new Uint8Array(await file.arrayBuffer());
		setCover.mutate(
			{ path: paths, image },
			{
				onSuccess: (report) => {
					bumpArt();
					const failed = report.failed[0];
					if (failed) {
						setError(`${report.failed.length} not saved: ${failed.error}`);
					}
				},
				onError: (e) => setError(String(e)),
			},
		);
	};

	// ⌘V with an image on the clipboard replaces the cover, unless typing in a field; for a song
	// on an album the card opens with it, asking which songs get it, as an upload would.
	const applyRef = useRef(apply);
	applyRef.current = apply;
	useEffect(() => {
		const onPaste = (ev: ClipboardEvent) => {
			const el = ev.target;
			if (el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea"))) {
				return;
			}
			// The open card takes the paste itself.
			if (openRef.current) {
				return;
			}
			const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
			if (item) {
				ev.preventDefault();
				void applyRef.current(item.getAsFile());
			}
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
	}, []);

	const busy = setCover.isPending;
	const triggerRef = useRef<HTMLButtonElement>(null);
	// The middle of the cover, read on every placement, so the card can open centred on it.
	const centre = {
		getBoundingClientRect: () => {
			const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect();
			return new DOMRect(rect.x + rect.width / 2, rect.y + rect.height / 2, 0, 0);
		},
	};
	return (
		<>
			<SaveState status={busy ? "saving" : error ? "error" : "saved"} error={error} />
			<Popover
				open={open}
				// A click in the file picker is a click outside the card, and must not close it.
				onOpenChange={(next) => {
					if (next || !isPickOpen()) {
						setOpen(next);
					}
					if (!next) {
						setPasted(null);
					}
				}}
			>
				<PopoverTrigger
					ref={triggerRef}
					aria-label={`Change the cover of ${name}`}
					data-hint={error ?? `Click to change the cover, or paste one (${keyLabel("⌘V")})`}
					disabled={busy}
					className={cn(
						"group/cover relative block size-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
						error && "ring-2 ring-destructive",
						className,
					)}
				>
					{children}
					<span
						className={cn(
							"absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 text-white transition-opacity [&_svg]:size-1/4 [&_svg]:max-w-8",
							busy
								? "opacity-100"
								: "opacity-0 group-hover/cover:opacity-100 group-focus-visible/cover:opacity-100",
						)}
					>
						{busy ? <LoaderCircle className="animate-spin" /> : <ImagePlus />}
					</span>
				</PopoverTrigger>
				{/* Centred on the cover and grown out from its middle, so the cover itself seems to grow. */}
				<PopoverPopup
					side="bottom"
					align="center"
					anchor={centre}
					sideOffset={-COVER_CARD_PX / 2}
					collisionPadding={12}
					aria-label={`Change the cover of ${name}`}
					className="size-60 max-w-[calc(100vw-2rem)] origin-center overflow-hidden rounded-xl bg-muted shadow-2xl outline-none ring-1 ring-foreground/15 transition-[transform,opacity] motion-pop data-[ending-style]:motion-leave data-[ending-style]:scale-[0.4] data-[starting-style]:scale-[0.4] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none"
				>
					<CoverCard
						paths={paths}
						name={name}
						album={album}
						pasted={pasted}
						onDone={() => {
							setOpen(false);
							setPasted(null);
						}}
					/>
				</PopoverPopup>
			</Popover>
		</>
	);
}
