import { createFileRoute } from "@tanstack/react-router";
import { TagDatabase } from "#/components/tag-database.tsx";

export const Route = createFileRoute("/metadata")({ component: TagDatabase });
