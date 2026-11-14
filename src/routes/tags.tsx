import { createFileRoute } from "@tanstack/react-router";
import { TagDatabase } from "#/components/tag-database.tsx";

export const Route = createFileRoute("/tags")({ component: TagsPage });

function TagsPage() {
	return (
		<main className="mx-auto w-full max-w-4xl space-y-6 p-6 lg:p-8">
			<header className="space-y-1">
				<h1 className="font-semibold text-2xl tracking-tight">Tag Database</h1>
				<p className="max-w-xl text-muted-foreground text-sm">
					Every artist, genre, label and tag in your library. Rename, merge or delete a value and
					every song that uses it is updated.
				</p>
			</header>
			<TagDatabase />
		</main>
	);
}
