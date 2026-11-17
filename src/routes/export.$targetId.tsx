import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TargetPage } from "#/components/target-page.tsx";
import { targetParamsSchema } from "#/lib/place-routes.ts";

export const Route = createFileRoute("/export/$targetId")({
	params: {
		parse: (raw) => targetParamsSchema.parse(raw),
		stringify: ({ targetId }) => ({ targetId: String(targetId) }),
	},
	component: TargetRoute,
});

function TargetRoute() {
	const { targetId } = Route.useParams();
	const navigate = useNavigate();
	return (
		<TargetPage key={targetId} id={targetId} onRemoved={() => void navigate({ to: "/export" })} />
	);
}
