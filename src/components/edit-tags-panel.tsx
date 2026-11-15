import { TagEditor, type TagTarget } from "#/components/tag-editor.tsx";
import { useDetail } from "#/context/detail-context.ts";
import { useTagConfirm } from "#/lib/use-tag-confirm.tsx";

/** The tag editor in the drawer, for several songs at once (a selection or one value's songs). */
export function EditTagsPanel({ target }: { target: TagTarget }) {
	const detail = useDetail();
	const tagConfirm = useTagConfirm();

	const done = () => (detail.canGoBack ? detail.back() : detail.close());

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
