import { createFileRoute } from "@tanstack/react-router";
import { ItunesPage } from "#/components/itunes-source.tsx";

export const Route = createFileRoute("/import/itunes")({ component: ItunesPage });
