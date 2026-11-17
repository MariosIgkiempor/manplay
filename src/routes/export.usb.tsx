import { createFileRoute } from "@tanstack/react-router";
import { UsbDrivePage } from "#/components/usb-drives.tsx";
import { usbSearchSchema } from "#/lib/place-routes.ts";

export const Route = createFileRoute("/export/usb")({
	validateSearch: (raw) => usbSearchSchema.parse(raw),
	component: UsbRoute,
});

function UsbRoute() {
	const { mount } = Route.useSearch();
	return <UsbDrivePage key={mount} mount={mount} />;
}
