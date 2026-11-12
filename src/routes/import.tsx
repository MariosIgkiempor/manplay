import { createFileRoute } from "@tanstack/react-router";
import { ImportView } from "#/components/import-view.tsx";

export const Route = createFileRoute("/import")({ component: ImportView });
