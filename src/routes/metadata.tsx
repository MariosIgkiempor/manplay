import { createFileRoute } from "@tanstack/react-router";
import { Page } from "#/components/page.tsx";
import { TagDatabase } from "#/components/tag-database.tsx";

export const Route = createFileRoute("/metadata")({ component: MetadataPage });

function MetadataPage() {
	return (
		<Page
			title="Metadata"
			description="Every artist, genre, label and library tag in your music. Click a value to see its songs. Rename, merge or delete it and every song that uses it is updated."
		>
			<TagDatabase />
		</Page>
	);
}
