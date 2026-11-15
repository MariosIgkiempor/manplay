import { useUiSetting } from "#/lib/queries.ts";
import {
	ALBUM_SORTS,
	type AlbumSort,
	ARTIST_SORTS,
	type ArtistSort,
	type ListSort,
	SONG_SORTS,
	type SongSort,
	type SortOption,
} from "#/lib/sorting.ts";

const isSort = (raw: unknown): raw is { key: string; desc: boolean } =>
	typeof raw === "object" &&
	raw !== null &&
	typeof (raw as { key?: unknown }).key === "string" &&
	typeof (raw as { desc?: unknown }).desc === "boolean";

/** A saved sort, if it is still one of `options`. */
function parseSort<K extends string>(options: readonly SortOption<K>[]) {
	return (raw: unknown): ListSort<K> | null =>
		isSort(raw) && options.some((o) => o.key === raw.key) ? (raw as ListSort<K>) : null;
}

const parseSongs = parseSort(SONG_SORTS);
const parseAlbums = parseSort(ALBUM_SORTS);
const parseArtists = parseSort(ARTIST_SORTS);

/** How each library view is sorted, kept in the database. */
export function useLibrarySorts() {
	const [songs, setSongs] = useUiSetting<ListSort<SongSort>>(
		"library.sort.songs",
		{ key: "artist", desc: false },
		parseSongs,
	);
	const [albums, setAlbums] = useUiSetting<ListSort<AlbumSort>>(
		"library.sort.albums",
		{ key: "artist", desc: false },
		parseAlbums,
	);
	const [artists, setArtists] = useUiSetting<ListSort<ArtistSort>>(
		"library.sort.artists",
		{ key: "name", desc: false },
		parseArtists,
	);
	return { songs, setSongs, albums, setAlbums, artists, setArtists };
}

export type LibrarySorts = ReturnType<typeof useLibrarySorts>;
