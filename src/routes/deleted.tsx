import { createFileRoute } from "@tanstack/react-router";
import { RecentlyDeleted } from "#/components/recently-deleted.tsx";

export const Route = createFileRoute("/deleted")({ component: RecentlyDeleted });
