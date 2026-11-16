import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	type SmartRules,
	saveSmartPlaylist,
	smartPlaylistPreview,
	smartPlaylists,
} from "#/lib/api.ts";
import { autoName, EMPTY_RULES } from "#/lib/smart-rules.ts";

/** The songs a rule set picks now; shared by the list's counts and the builder's preview. */
export function useSmartPreview(rules: SmartRules, enabled = true) {
	return useQuery({
		queryKey: ["smart-preview", rules],
		queryFn: () => smartPlaylistPreview(rules),
		placeholderData: keepPreviousData,
		enabled,
	});
}

export const SMART_KEY = ["smart-playlists"];

export function useSmartPlaylists() {
	return useQuery({ queryKey: SMART_KEY, queryFn: smartPlaylists });
}

/** Makes an empty smart playlist and opens its page. */
export function useCreateSmartPlaylist() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: () => saveSmartPlaylist({ id: 0, name: autoName(EMPTY_RULES), rules: EMPTY_RULES }),
		onSuccess: async (made) => {
			await queryClient.invalidateQueries({ queryKey: SMART_KEY });
			await navigate({ to: "/smart/$id", params: { id: String(made.id) } });
		},
	});
}
