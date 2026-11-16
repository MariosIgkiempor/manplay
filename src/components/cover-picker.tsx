import { ImagePlus, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SaveState } from "#/components/save-state.tsx";
import { bumpArt } from "#/lib/art-version.ts";
import { keyLabel } from "#/lib/platform.ts";
import { useTagsSetCover } from "#/lib/queries.ts";
import { cn } from "#/lib/utils.ts";

const COVER_TYPES = ["image/jpeg", "image/png"];

/**
 * Cover art you can replace: click it to choose an image file, or press ⌘V with an image copied.
 * The new cover is written to the song, or every song of the album, straight away; the status
 * bar says "Saving…", then "Saved".
 */
export function CoverPicker({
	paths,
	name,
	children,
	className,
}: {
	/** The song, or every song the cover goes to. */
	paths: string | readonly string[];
	/** What the cover belongs to, for its label. */
	name: string;
	children: ReactNode;
	className?: string;
}) {
	const setCover = useTagsSetCover();
	const fileInput = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);

	const apply = async (file: Blob | null | undefined) => {
		if (!file) {
			return;
		}
		if (!COVER_TYPES.includes(file.type)) {
			setError("Use a JPEG or PNG image");
			return;
		}
		setError(null);
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

	// ⌘V with an image on the clipboard replaces the cover, unless typing in a field.
	const applyRef = useRef(apply);
	applyRef.current = apply;
	useEffect(() => {
		const onPaste = (ev: ClipboardEvent) => {
			const el = ev.target;
			if (el instanceof HTMLElement && (el.isContentEditable || el.matches("input, textarea"))) {
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
	return (
		<>
			<SaveState status={busy ? "saving" : error ? "error" : "saved"} error={error} />
			<button
				type="button"
				aria-label={`Replace the cover of ${name}`}
				title={error ?? `Click to choose a new cover, or paste one (${keyLabel("⌘V")})`}
				disabled={busy}
				onClick={() => fileInput.current?.click()}
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
			</button>
			<input
				ref={fileInput}
				type="file"
				accept={COVER_TYPES.join(",")}
				className="hidden"
				onChange={(e) => {
					void apply(e.target.files?.[0]);
					e.target.value = "";
				}}
			/>
		</>
	);
}
