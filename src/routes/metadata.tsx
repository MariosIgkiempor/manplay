import { createFileRoute } from "@tanstack/react-router";
import { Page } from "#/components/page.tsx";
import { TagDatabase } from "#/components/tag-database.tsx";

export const Route = createFileRoute("/metadata")({ component: MetadataPage });

function MetadataPage() {
	return (
		<Page title="Metadata">
			<TagDatabase />
		</Page>
	);
}
