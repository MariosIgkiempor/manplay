import { createFileRoute } from "@tanstack/react-router";
import { ImportFolderPage } from "#/components/import-folder.tsx";
import { folderParamsSchema } from "#/lib/place-routes.ts";

export const Route = createFileRoute("/import/$folderId")({
	params: {
		parse: (raw) => folderParamsSchema.parse(raw),
		stringify: ({ folderId }) => ({ folderId: String(folderId) }),
	},
	component: FolderRoute,
});

function FolderRoute() {
	const { folderId } = Route.useParams();
	return <ImportFolderPage key={folderId} id={folderId} />;
}
