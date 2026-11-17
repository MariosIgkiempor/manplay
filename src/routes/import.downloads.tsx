import { createFileRoute } from "@tanstack/react-router";
import { DownloadsPage } from "#/components/downloads-source.tsx";

export const Route = createFileRoute("/import/downloads")({ component: DownloadsPage });
