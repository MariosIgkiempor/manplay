import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { AddR2, AddTailscale } from "#/components/add-destination.tsx";
import { type Brand, BrandIcon } from "#/components/brand-icon.tsx";
import { Drawer } from "#/components/drawer.tsx";
import { Framed } from "#/components/frame.tsx";
import { EmptyState, ErrorLine } from "#/components/page.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PlaceCrumb } from "#/components/place-crumb.tsx";
import { PlaceFrame } from "#/components/place-page.tsx";
import { PullReview } from "#/components/pull-review.tsx";
import { JoinLibraryDialog } from "#/components/shared-library.tsx";
import { Button } from "#/components/ui/button.tsx";
import { PAGE_ART, WELL_ROWS } from "#/lib/page-layout.ts";
import type { DestinationService } from "#/lib/places.ts";
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
		title: "rekordbox XML",
		what: "A file rekordbox imports your playlists from",
	},
	{ id: "usb", brand: "usb", title: "CDJ USB drive", what: "A stick for Pioneer CDJs and XDJs" },
];

function Heading({ brand, title }: { brand?: Brand | undefined; title: string }) {
	const navigate = useNavigate();
	return (
		<PageHeader
			art={brand ? <BrandIcon brand={brand} className={PAGE_ART} /> : null}
			kind={
				<>
					<PlaceCrumb section="export" current="add" />
					{brand && (
						<>
							<ChevronRight className="size-3.5 shrink-0" />
							<button
								type="button"
								onClick={() => void navigate({ to: "/export/add", search: {} })}
								className="hover:text-foreground hover:underline"
							>
								Other kinds
							</button>
						</>
					)}
				</>
			}
			title={title}
		/>
	);
}

/** Step one: pick what kind of destination. */
function Pick() {
	const navigate = useNavigate();
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
		<PlaceFrame header={<Heading title="Where to?" />}>
			<Framed>
				<ul className={WELL_ROWS}>
					{SERVICES.map((s) => (
						<li key={s.id}>
							<button
								type="button"
								onClick={() => void navigate({ to: "/export/add", search: { service: s.id } })}
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
			</Framed>
		</PlaceFrame>
	);
}

const plural = (n: number) => `${n} plugged in`;

/** Tailscale or R2: the form, then a look at what is already there to pull. */
function SyncTargetStep({ service }: { service: "tailscale" | "r2" }) {
	const navigate = useNavigate();
	const openTarget = (targetId: number) =>
		void navigate({ to: "/export/$targetId", params: { targetId } });
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
		<PlaceFrame header={<Heading brand={meta?.brand} title={meta?.title ?? ""} />}>
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
				onClose={() => added !== null && openTarget(added)}
				title="Pull existing files"
				width="w-[44rem]"
			>
				{added !== null && <PullReview targetId={added} onDone={() => openTarget(added)} />}
			</Drawer>
		</PlaceFrame>
	);
}

function RekordboxStep() {
	const navigate = useNavigate();
	const openRekordbox = () => void navigate({ to: "/export/rekordbox" });
	const { status, choose } = useRekordbox();
	const path = status.data?.path ?? null;
	return (
		<PlaceFrame header={<Heading brand="rekordbox" title="rekordbox XML" />}>
			<div className="space-y-3 rounded-xl border border-hairline border-dashed p-5 text-center">
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
								onSuccess: (next) => next && openRekordbox(),
							})
						}
					>
						<FolderOpen /> {path ? "Change location…" : "Choose location…"}
					</Button>
					{path && <Button onClick={openRekordbox}>Open</Button>}
				</div>
			</div>
			{choose.isError && <ErrorLine>{String(choose.error)}</ErrorLine>}
		</PlaceFrame>
	);
}

function UsbStep() {
	const navigate = useNavigate();
	const drives = useUsbDrives().data ?? [];
	return (
		<PlaceFrame header={<Heading brand="usb" title="CDJ USB drive" />}>
			{drives.length === 0 ? (
				<div className="rounded-xl border border-hairline border-dashed">
					<EmptyState title="Plug in a USB drive">
						It shows up here, and in your destinations, while it's plugged in.
					</EmptyState>
				</div>
			) : (
				<Framed>
					<ul className={WELL_ROWS}>
						{drives.map((d) => (
							<li key={d.mount}>
								<button
									type="button"
									onClick={() => void navigate({ to: "/export/usb", search: { mount: d.mount } })}
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
				</Framed>
			)}
		</PlaceFrame>
	);
}

/** Add an export destination: pick the service, then set it up. */
export function AddDestinationPage({ service }: { service?: DestinationService | undefined }) {
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
