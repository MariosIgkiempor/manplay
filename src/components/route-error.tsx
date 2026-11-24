import { Link, useRouter } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { EmptyState } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { describeError } from "#/lib/errors.ts";
import { PAGE_BODY } from "#/lib/page-layout.ts";

/**
 * A page that could not be shown, e.g. a link to a destination that no longer exists: what went
 * wrong in plain words and two ways on, inside the app's own frame instead of the router's bare
 * error text. The raw message stays one hover away for a bug report.
 */
export function RouteError({ error }: { error: unknown }) {
	const router = useRouter();
	const raw = error instanceof Error ? error.message : String(error);
	// A link the app cannot read fails its schema: say that, not the schema's own report.
	const unreadable = raw.trimStart().startsWith("[");
	const { title, detail } = unreadable
		? {
				title: "This page does not exist",
				detail: "The link points at something manplay does not have.",
			}
		: describeError(raw);
	return (
		<main className={PAGE_BODY}>
			<EmptyState
				icon={<TriangleAlert className="text-warning" />}
				title={typeof title === "string" ? title : "This page could not be shown"}
				action={
					<div className="flex items-center gap-2">
						<Button variant="outline" size="sm" onClick={() => void router.invalidate()}>
							Try again
						</Button>
						<Button size="sm" render={<Link to="/" />}>
							Back to Library
						</Button>
					</div>
				}
			>
				<span data-hint={raw}>{detail ?? "Something went wrong opening it."}</span>
			</EmptyState>
		</main>
	);
}
