import { Link, useMatchRoute } from "@tanstack/react-router";
import { Usb } from "lucide-react";
import { SectionLabel } from "#/components/sidebar-parts.tsx";
import { rowBase, rowClass } from "#/components/sidebar-row.ts";
import { useDetail } from "#/context/detail-context.ts";
import { formatBytes } from "#/lib/format.ts";
import { space, useUsbDrives } from "#/lib/use-usb.ts";

/** Plugged-in CDJ USB drives; each opens the Export page on that drive. Hidden when none are in. */
export function SidebarDrives() {
	const drives = useUsbDrives().data ?? [];
	const detail = useDetail();
	const onExport = !!useMatchRoute()({ to: "/export" });
	if (drives.length === 0) {
		return null;
	}
	return (
		<section className="mb-4 space-y-0.5">
			<SectionLabel>USB drives</SectionLabel>
			{drives.map((d) => {
				const active = onExport && detail.view?.kind === "usb" && detail.view.mount === d.mount;
				return (
					<div key={d.mount} className={rowClass(active)}>
						<Link
							to="/export"
							search={{ usb: d.mount }}
							title={`${d.name}, ${space(d)}`}
							className={rowBase}
						>
							<Usb className="size-4 shrink-0" />
							<span className="truncate">{d.name}</span>
							<span className="ml-auto pl-2 text-xs tabular-nums">{formatBytes(d.freeBytes)}</span>
						</Link>
						<span className="size-5 shrink-0" />
					</div>
				);
			})}
		</section>
	);
}
