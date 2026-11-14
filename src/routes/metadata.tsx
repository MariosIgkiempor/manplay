import { createFileRoute } from "@tanstack/react-router";
import { TagDatabase } from "#/components/tag-database.tsx";

export const Route = createFileRoute("/metadata")({ component: MetadataPage });

function MetadataPage() {
	return (
		<main className="mx-auto w-full max-w-5xl space-y-8 p-6 lg:p-8">
			<header className="space-y-1">
				<h1 className="font-semibold text-2xl tracking-tight">Metadata</h1>
				<p className="max-w-xl text-muted-foreground text-sm">
					Every artist, genre, label and library tag. Rename, merge or delete a value and every song
					that uses it is updated.
				</p>
			</header>
			<TagDatabase />
		</main>
	);
}
