import { useQueries } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, Tags } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Button } from "#/components/ui/button.tsx";
import { tagsPreview } from "#/lib/api.ts";
import {
	diffNames,
	type FieldSummary,
	type FileChanges,
	isMulti,
	isReorder,
	labelOf,
	summarize,
} from "#/lib/tag-preview.ts";
import type { TagConfirmRequest } from "#/lib/use-tag-confirm.tsx";
import { cn } from "#/lib/utils.ts";

const MAX_FILES = 60;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const parentName = (path: string) => path.split(/[\\/]/).slice(-3, -1).join(" / ");
const songs = (n: number) => `${n} ${n === 1 ? "song" : "songs"}`;

const chip = "inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 text-xs";

function Empty() {
	return <span className={cn(chip, "bg-muted text-muted-foreground italic")}>empty</span>;
}

/** A tag value as chips: one per name for list tags, one chip otherwise. */
function Chips({ field, value }: { field: string; value: string | null }) {
	if (value === null) {
		return <Empty />;
	}
	const names = isMulti(field) ? value.split(";").map((n) => n.trim()) : [value];
	return (
		<span className="inline-flex flex-wrap gap-1">
			{names
				.filter((n) => n !== "")
				.map((n) => (
					<span key={n} className={cn(chip, "bg-secondary text-secondary-foreground")}>
						<span className="break-words">{n}</span>
					</span>
				))}
		</span>
	);
}

function DiffChips({ from, to }: { from: string | null; to: string | null }) {
	return (
		<span className="inline-flex flex-wrap items-center gap-1">
			{diffNames(from, to).map((d) => (
				<span
					key={`${d.state}-${d.name}`}
					className={cn(
						chip,
						d.state === "kept" && "bg-secondary text-secondary-foreground",
						d.state === "added" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
						d.state === "removed" && "bg-destructive/10 text-destructive line-through",
					)}
				>
					{d.state === "added" && <span className="mr-1 font-medium">+</span>}
					<span className="break-words">{d.name}</span>
				</span>
			))}
		</span>
	);
}

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
			<div
				aria-hidden="true"
				onMouseDown={() => onDone(false)}
				className="absolute inset-0 animate-in bg-background/60 backdrop-blur-sm fade-in motion-reduce:animate-none"
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={req.title}
				className="relative flex max-h-[85vh] w-[38rem] max-w-[calc(100%-2rem)] animate-in flex-col overflow-hidden rounded-xl border bg-background shadow-2xl duration-150 fade-in zoom-in-95 motion-reduce:animate-none"
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
							<kbd className="ml-1 rounded bg-primary-foreground/20 px-1 font-sans text-[10px]">
								⌘↵
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
		return <p className="text-destructive">{String(error)}</p>;
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
			<section className="space-y-2.5">
				{rows.map((r) => (
					<FieldRow key={r.field} row={r} />
				))}
			</section>
			<PerFile files={files} />
		</>
	);
}

function FieldRow({ row: r }: { row: FieldSummary }) {
	const single = r.was.length === 1 ? r.was[0] : undefined;
	// One shared old value and a list tag: show exactly which names come and go.
	const diff = single !== undefined && isMulti(r.field);
	return (
		<div className="rounded-lg border px-3.5 py-3">
			<div className="mb-2 flex items-baseline justify-between gap-2">
				<span className="font-medium">{r.label}</span>
				<span className="text-muted-foreground text-xs">{songs(r.songs)}</span>
			</div>
			{diff ? (
				<div className="space-y-1.5">
					<DiffChips from={single.value} to={r.to} />
					{isReorder(single.value, r.to) && (
						<div className="text-muted-foreground text-xs">Same names, new order.</div>
					)}
				</div>
			) : (
				<div className="grid grid-cols-[3.5rem_1fr] items-start gap-x-2 gap-y-1.5">
					<span className="pt-0.5 text-muted-foreground text-xs">Before</span>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						{r.was.slice(0, 4).map((w) => (
							<span key={w.value ?? "∅"} className="inline-flex items-center gap-1">
								<Chips field={r.field} value={w.value} />
								{r.was.length > 1 && (
									<span className="text-muted-foreground text-xs">×{w.count}</span>
								)}
							</span>
						))}
						{r.was.length > 4 && (
							<span className="text-muted-foreground text-xs">+{r.was.length - 4} more</span>
						)}
					</div>
					<span className="pt-0.5 text-primary text-xs">After</span>
					{r.to === null ? (
						<span className={cn(chip, "w-fit bg-destructive/10 text-destructive")}>Cleared</span>
					) : (
						<Chips field={r.field} value={r.to} />
					)}
				</div>
			)}
		</div>
	);
}

function PerFile({ files }: { files: FileChanges[] }) {
	return (
		<details className="group">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
				Changes per song
			</summary>
			<ul className="mt-2 divide-y rounded-lg border">
				{files.slice(0, MAX_FILES).map((f) => (
					<li key={f.path} className="px-3 py-2 text-xs">
						<div className="flex items-baseline gap-2">
							<span className="truncate font-medium" title={f.path}>
								{fileName(f.path)}
							</span>
							<span className="ml-auto shrink-0 truncate text-muted-foreground">
								{parentName(f.path)}
							</span>
						</div>
						{f.changes.map((c) => (
							<div key={c.field} className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
								<span className="w-20 shrink-0 text-muted-foreground">{labelOf(c.field)}</span>
								{isMulti(c.field) ? (
									<DiffChips from={c.from} to={c.to} />
								) : (
									<>
										<Chips field={c.field} value={c.from} />
										<ArrowRight className="size-3 shrink-0 text-muted-foreground" />
										{c.to === null ? (
											<span className={cn(chip, "bg-destructive/10 text-destructive")}>
												cleared
											</span>
										) : (
											<Chips field={c.field} value={c.to} />
										)}
									</>
								)}
							</div>
						))}
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
