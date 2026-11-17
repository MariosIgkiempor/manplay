import { createFileRoute } from "@tanstack/react-router";
import { AddDestinationPage } from "#/components/add-destination-page.tsx";
import { addSearchSchema } from "#/lib/place-routes.ts";

export const Route = createFileRoute("/export/add")({
	validateSearch: (raw) => addSearchSchema.parse(raw),
	component: AddRoute,
});

function AddRoute() {
	const { service } = Route.useSearch();
	return <AddDestinationPage key={service ?? "pick"} service={service} />;
}
