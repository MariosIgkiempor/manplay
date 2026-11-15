import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	pickRekordboxFile,
	type RekordboxStatus,
	rekordboxStatus,
	setRekordboxPath,
} from "#/lib/api.ts";
import { useServices } from "#/lib/queries.ts";

export function useRekordbox() {
	const queryClient = useQueryClient();
	const status = useQuery({ queryKey: ["rekordbox"], queryFn: rekordboxStatus });
	const update = (next: RekordboxStatus) => {
		queryClient.setQueryData(["rekordbox"], next);
		void queryClient.invalidateQueries({ queryKey: ["rekordbox-library"] });
		void queryClient.invalidateQueries({ queryKey: ["activity", "rekordbox"] });
	};
	const choose = useMutation({
		mutationFn: async () => {
			const path = await pickRekordboxFile();
			return path === null ? null : setRekordboxPath(path);
		},
		onSuccess: (next) => {
			if (next) {
				update(next);
			}
		},
	});
	const stop = useMutation({ mutationFn: () => setRekordboxPath(null), onSuccess: update });
	const services = useServices();
	return {
		status,
		choose,
		stop,
		enabled: services.isEnabled("rekordbox", status.data?.path != null),
		setEnabled: (on: boolean) => services.setEnabled("rekordbox", on),
	};
}
