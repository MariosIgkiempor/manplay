import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TargetPage } from "#/components/target-page.tsx";
import { targetParamsSchema, targetSearchSchema } from "#/lib/place-routes.ts";

export const Route = createFileRoute("/export/$targetId")({
	params: {
		parse: (raw) => targetParamsSchema.parse(raw),
		stringify: ({ targetId }) => ({ targetId: String(targetId) }),
	},
	validateSearch: (search) => targetSearchSchema.parse(search),
	component: TargetRoute,
});

function TargetRoute() {
	const { targetId } = Route.useParams();
	const { mode } = Route.useSearch();
	const navigate = useNavigate();
	return (
		<TargetPage
			key={targetId}
			id={targetId}
			mode={mode}
			onRemoved={() => void navigate({ to: "/export" })}
		/>
	);
}
