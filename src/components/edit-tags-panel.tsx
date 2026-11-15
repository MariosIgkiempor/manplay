import { TagEditor, type TagTarget } from "#/components/tag-editor.tsx";
import { useTagConfirm } from "#/lib/use-tag-confirm.tsx";

/** The tag editor in the drawer, for several songs at once (a selection or one value's songs). */
export function EditTagsPanel({ target }: { target: TagTarget }) {
	const tagConfirm = useTagConfirm();

	return (
		<div className="-mx-5 -mt-5 flex h-full flex-col">
			<TagEditor
				key={target.paths?.join("\n") ?? target.path}
				target={target}
				confirm={tagConfirm.ask}
			/>
			{tagConfirm.dialog}
		</div>
	);
}
