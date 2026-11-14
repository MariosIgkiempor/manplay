import { TagEditor, type TagTarget } from "#/components/tag-editor.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { albumKey } from "#/lib/albums.ts";
import { useTracks } from "#/lib/queries.ts";
import { useTagConfirm } from "#/lib/use-tag-confirm.tsx";

/** The Files tab's tag editor, for songs picked in the library. */
export function EditTagsPanel({ target, fromAlbum }: { target: TagTarget; fromAlbum: boolean }) {
	const detail = useDetail();
	const tracks = useTracks();
	const tagConfirm = useTagConfirm();

	const done = () => {
		if (fromAlbum) {
			// The album may have been renamed: reopen it under whatever it is called now.
			const song = tracks.data?.find((t) => t.path === target.path);
			if (song) {
				detail.open({ kind: "album", key: albumKey(song.artist, song.album) });
				return;
			}
		}
		if (detail.canGoBack) {
			detail.back();
		} else {
			detail.close();
		}
	};

	return (
		<div className="-mx-5 -mt-5 flex h-full flex-col">
			<TagEditor
				key={target.paths?.join("\n") ?? target.path}
				target={target}
				onClose={done}
				confirm={tagConfirm.ask}
			/>
			{tagConfirm.dialog}
		</div>
	);
}
