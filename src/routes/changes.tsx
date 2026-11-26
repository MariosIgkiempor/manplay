import { createFileRoute } from "@tanstack/react-router";
import { LibraryChanges } from "#/components/library-changes.tsx";

export const Route = createFileRoute("/changes")({ component: LibraryChanges });
