import { useQueries } from "@tanstack/react-query";
import { ChevronRight, Tags } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { ErrorLine } from "#/components/page.tsx";
import { TagChanges, TagRow } from "#/components/tag-diff.tsx";
import { Button } from "#/components/ui/button.tsx";
import { tagsPreview } from "#/lib/api.ts";
import { DIALOG_BACKDROP, DIALOG_FRAME, WELL_ROWS } from "#/lib/page-layout.ts";
import { keyLabel } from "#/lib/platform.ts";
import { type FieldSummary, type FileChanges, summarize } from "#/lib/tag-preview.ts";
import type { TagConfirmRequest } from "#/lib/use-tag-confirm.tsx";
import { cn } from "#/lib/utils.ts";

const MAX_FILES = 60;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const parentName = (path: string) => path.split(/[\\/]/).slice(-3, -1).join(" / ");
const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

export function TagConfirmDialog({
	req,
	onDone,
}: {
	req: TagConfirmRequest;
	onDone: (ok: boolean) => void;
}) {
	const previews = useQueries({
		queries: req.items.map((i) => ({
			queryKey: ["tags-preview", i.path, i.edits],
			queryFn: () => tagsPreview(i.path, i.edits),
			gcTime: 0,
		})),
	});
	const loading = previews.some((p) => p.isPending);
	const failed = previews.find((p) => p.isError);
	const total = previews.reduce((n, p) => n + (p.data?.total ?? 0), 0);
	const files: FileChanges[] = useMemo(
		() => previews.flatMap((p) => p.data?.files ?? []),
		[previews],
	);
	const rows = useMemo(() => summarize(files), [files]);
	const ready = !loading && !failed && files.length > 0;
	const applyRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onDone(false);
			} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) {
				onDone(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onDone, ready]);
	// Land on Apply once there is something to apply, so Enter confirms.
	useEffect(() => {
		if (ready) {
			applyRef.current?.focus();
		}
	}, [ready]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div aria-hidden="true" onMouseDown={() => onDone(false)} className={DIALOG_BACKDROP} />
			<div
				role="dialog"
				aria-modal="true"
				aria-label={req.title}
				className={cn(
					DIALOG_FRAME,
					"flex max-h-[85vh] w-[38rem] max-w-[calc(100%-2rem)] flex-col overflow-hidden",
				)}
			>
				<div className="flex items-start gap-3 border-b px-5 py-4">
					<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<Tags className="size-4" />
					</span>
					<div className="min-w-0">
						<div className="truncate font-medium">{req.title}</div>
						{req.subtitle && (
							<div className="truncate text-muted-foreground text-sm">{req.subtitle}</div>
						)}
					</div>
				</div>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
					<Body loading={loading} error={failed?.error} rows={rows} files={files} />
				</div>
				<div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-5 py-3">
					<span className="text-muted-foreground text-xs">
						{loading
							? "Checking songs…"
							: `${files.length} of ${songs(total)} will change${files.length < total ? `, ${total - files.length} already match` : ""}`}
					</span>
					<div className="flex items-center gap-2">
						<Button variant="ghost" onClick={() => onDone(false)}>
							Cancel
						</Button>
						<Button ref={applyRef} onClick={() => onDone(true)} disabled={!ready}>
							{ready ? `Apply to ${songs(files.length)}` : "Apply"}
							<kbd className="ml-1 rounded-md bg-primary-foreground/20 px-1 font-sans text-xs">
								{keyLabel("⌘↵")}
							</kbd>
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

function Body({
	loading,
	error,
	rows,
	files,
}: {
	loading: boolean;
	error: unknown;
	rows: FieldSummary[];
	files: FileChanges[];
}) {
	if (error) {
		return <ErrorLine>{String(error)}</ErrorLine>;
	}
	if (loading) {
		return (
			<div className="space-y-2" aria-busy="true">
				{[0, 1].map((n) => (
					<div
						key={n}
						className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
					/>
				))}
			</div>
		);
	}
	if (files.length === 0) {
		return (
			<p className="py-6 text-center text-muted-foreground">
				Nothing to change. These songs already have these tags.
			</p>
		);
	}
	return (
		<>
			<section className="space-y-1">
				{rows.map((r) => (
					<TagRow key={r.field} field={r.field} was={r.was} to={r.to} />
				))}
			</section>
			<PerFile files={files} />
		</>
	);
}

function PerFile({ files }: { files: FileChanges[] }) {
	return (
		<details className="group">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
				Changes per song
			</summary>
			<ul className={`${WELL_ROWS} mt-2`}>
				{files.slice(0, MAX_FILES).map((f) => (
					<li key={f.path} className="px-3 py-2 text-xs">
						<div className="flex items-baseline gap-2">
							<span className="truncate font-medium" data-hint={f.path}>
								{fileName(f.path)}
							</span>
							<span className="ml-auto shrink-0 truncate text-muted-foreground">
								{parentName(f.path)}
							</span>
						</div>
						<div className="mt-1.5">
							<TagChanges changes={f.changes} />
						</div>
					</li>
				))}
				{files.length > MAX_FILES && (
					<li className="px-3 py-2 text-muted-foreground text-xs">
						and {files.length - MAX_FILES} more songs
					</li>
				)}
			</ul>
		</details>
	);
}
