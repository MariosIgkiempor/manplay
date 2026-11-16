import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FilesView } from "#/components/files-view.tsx";

export const Route = createFileRoute("/files")({
	// `?target=<id>` shows that destination in the first pane instead of the library.
	validateSearch: (search: { target?: unknown }): { target?: number } => {
		const id = Number(search.target);
		return Number.isInteger(id) && id > 0 ? { target: id } : {};
	},
	component: FilesPage,
});

function FilesPage() {
	const { target } = Route.useSearch();
	const navigate = useNavigate();
	return (
		<FilesView
			target={target}
			onSourceChange={(next) =>
				void navigate({ to: "/files", search: next === undefined ? {} : { target: next } })
			}
		/>
	);
}
