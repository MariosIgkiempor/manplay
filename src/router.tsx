import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { RouteError } from "#/components/route-error.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
		defaultErrorComponent: RouteError,
		// Pages scroll past each other as the path changes (`page-transition.ts`); a change of
		// search only, such as a tab, does not move the page.
		defaultViewTransition: { types: ({ pathChanged }) => (pathChanged ? ["page"] : false) },
	});

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
