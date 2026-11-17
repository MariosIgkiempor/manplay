import { ChevronRight, FolderOpen, Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { AddR2, AddTailscale } from "#/components/add-destination.tsx";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PullReview } from "#/components/pull-review.tsx";
import { JoinLibraryDialog } from "#/components/shared-library.tsx";
import { Button } from "#/components/ui/button.tsx";
import { type DestinationService, useDetail } from "#/context/detail-context.ts";
import { useSyncTargets } from "#/lib/queries.ts";
import { useRekordbox } from "#/lib/use-rekordbox.ts";
import { space, useUsbDrives } from "#/lib/use-usb.ts";

const SERVICES: { id: DestinationService; brand: Brand; title: string; what: string }[] = [
	{
		id: "tailscale",
		brand: "tailscale",
		title: "Tailscale folder",
		what: "A folder shared from one of your machines",
	},
	{ id: "r2", brand: "cloudflare", title: "Cloudflare R2", what: "A bucket, or a folder in one" },
	{
		id: "rekordbox",
		brand: "rekordbox",
		title: "Rekordbox XML",
		what: "A file rekordbox imports your playlists from",
	},
	{ id: "usb", brand: "usb", title: "CDJ USB drive", what: "A stick for Pioneer CDJs and XDJs" },
];

function Heading({ brand, title }: { brand?: Brand | undefined; title: string }) {
	return (
		<PageHeader
			variant="panel"
			art={
				brand ? (
					<BrandIcon brand={brand} className="size-24 shrink-0 rounded-xl" />
				) : (
					<div className="grid size-24 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-9">
						<Plus />
					</div>
				)
			}
			kind={
				<>
					<Upload /> Add destination
				</>
			}
			title={title}
		/>
	);
}

/** Step one: pick what kind of destination. */
function Pick() {
	const detail = useDetail();
	const rekordbox = useRekordbox().status.data;
	const drives = useUsbDrives().data ?? [];
	const note = (id: DestinationService) => {
		if (id === "rekordbox" && rekordbox?.path) {
			return "Already set up";
		}
		if (id === "usb") {
			return drives.length === 0 ? "None plugged in" : plural(drives.length);
		}
		return null;
	};
	return (
		<div className="space-y-5 pb-6">
			<Heading title="Where to?" />
			<ul className="divide-y overflow-hidden rounded-lg border">
				{SERVICES.map((s) => (
					<li key={s.id}>
						<button
							type="button"
							onClick={() => detail.push({ kind: "add-destination", service: s.id })}
							className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
						>
							<BrandIcon brand={s.brand} className="size-9" />
							<span className="min-w-0 flex-1">
								<span className="block font-medium text-sm">{s.title}</span>
								<span className="block truncate text-muted-foreground text-xs">{s.what}</span>
							</span>
							{note(s.id) && (
								<span className="shrink-0 text-muted-foreground text-xs">{note(s.id)}</span>
							)}
							<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

const plural = (n: number) => `${n} plugged in`;

/** Tailscale or R2: the form, then a look at what is already there to pull. */
function SyncTargetStep({ service }: { service: "tailscale" | "r2" }) {
	const detail = useDetail();
	const [added, setAdded] = useState<number | null>(null);
	// A new destination is first asked what it should be: part of the shared library, or files
	// only. A device already in a library keeps it files only; Sync has "Join or start".
	const [asked, setAsked] = useState<number | null>(null);
	const [offering, setOffering] = useState<number | null>(null);
	const targets = useSyncTargets().data;
	useEffect(() => {
		if (
			added !== null &&
			added !== asked &&
			offering === null &&
			targets?.some((t) => t.id === added)
		) {
			if (targets.some((t) => t.libsync)) {
				setAsked(added);
			} else {
				setOffering(added);
			}
		}
	}, [added, asked, offering, targets]);
	const offer = targets?.find((t) => t.id === offering);
	const meta = SERVICES.find((s) => s.id === service);
	return (
		<div className="space-y-5 pb-6">
			<Heading brand={meta?.brand} title={meta?.title ?? ""} />
			{service === "r2" ? <AddR2 onAdded={setAdded} /> : <AddTailscale onAdded={setAdded} />}
			{offer && (
				<JoinLibraryDialog
					target={offer}
					onClose={() => {
						setAsked(offer.id);
						setOffering(null);
					}}
				/>
			)}
			<Drawer
				open={added !== null && added === asked}
				onClose={() => added !== null && detail.open({ kind: "target", id: added })}
				title="Pull existing files"
				width="w-[44rem]"
			>
				{added !== null && (
					<PullReview targetId={added} onDone={() => detail.open({ kind: "target", id: added })} />
				)}
			</Drawer>
		</div>
	);
}

function RekordboxStep() {
	const detail = useDetail();
	const { status, choose } = useRekordbox();
	const path = status.data?.path ?? null;
	return (
		<div className="space-y-5 pb-6">
			<Heading brand="rekordbox" title="Rekordbox XML" />
			<div className="space-y-3 rounded-lg border border-dashed p-5 text-center">
				<p className="text-sm">
					{path ? (
						<>
							Already writing to <span className="font-mono text-xs">{path}</span>
						</>
					) : (
						"Choose where to save the file. Nothing is written until you export."
					)}
				</p>
				<div className="flex justify-center gap-2">
					<Button
						disabled={choose.isPending}
						variant={path ? "outline" : "default"}
						onClick={() =>
							choose.mutate(undefined, {
								onSuccess: (next) => next && detail.open({ kind: "service", service: "rekordbox" }),
							})
						}
					>
						<FolderOpen /> {path ? "Change location…" : "Choose location…"}
					</Button>
					{path && (
						<Button onClick={() => detail.open({ kind: "service", service: "rekordbox" })}>
							Open
						</Button>
					)}
				</div>
			</div>
			{choose.isError && <ErrorLine>{String(choose.error)}</ErrorLine>}
		</div>
	);
}

function UsbStep() {
	const detail = useDetail();
	const drives = useUsbDrives().data ?? [];
	return (
		<div className="space-y-5 pb-6">
			<Heading brand="usb" title="CDJ USB drive" />
			{drives.length === 0 ? (
				<div className="rounded-lg border border-dashed">
					<EmptyState title="Plug in a USB drive">
						It shows up here, and in your destinations, while it's plugged in.
					</EmptyState>
				</div>
			) : (
				<ul className="divide-y overflow-hidden rounded-lg border">
					{drives.map((d) => (
						<li key={d.mount}>
							<button
								type="button"
								onClick={() => detail.open({ kind: "usb", mount: d.mount })}
								className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate font-medium text-sm">{d.name}</span>
									<span className="block truncate text-muted-foreground text-xs">
										{space(d)}
										{d.hasLibrary ? "" : ", no rekordbox library yet"}
									</span>
								</span>
								<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Add an export destination: pick the service, then set it up. */
export function AddDestinationPanel({ service }: { service?: DestinationService | undefined }) {
	if (service === "tailscale" || service === "r2") {
		return <SyncTargetStep service={service} />;
	}
	if (service === "rekordbox") {
		return <RekordboxStep />;
	}
	if (service === "usb") {
		return <UsbStep />;
	}
	return <Pick />;
}
