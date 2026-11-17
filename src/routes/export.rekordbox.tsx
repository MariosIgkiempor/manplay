import { createFileRoute } from "@tanstack/react-router";
import { RekordboxPage } from "#/components/rekordbox-source.tsx";

export const Route = createFileRoute("/export/rekordbox")({ component: RekordboxPage });
