import { StartClient } from "@tanstack/react-start/client";
// biome-ignore lint/correctness/noUnresolvedImports: react exports StrictMode; Biome cannot see it.
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";

// `vite --mode harness` runs the app in a plain browser against a fake backend, for agents
// (docs/harness.md). The import is dropped from every other build.
if (import.meta.env.MODE === "harness") {
	const { installFakeBackend } = await import("#/harness/install.ts");
	installFakeBackend();
}

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<StartClient />
		</StrictMode>,
	);
});
