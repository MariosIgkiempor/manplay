import { TagEditor, type TagTarget } from "#/components/tag-editor.tsx";

/** The tag editor in the side panel, for several songs at once (a selection or one value's songs). */
export function EditTagsPanel({ target }: { target: TagTarget }) {
	return (
		<div className="-mx-5 -mt-5 flex h-full flex-col">
			<TagEditor key={target.paths?.join("\n") ?? target.path} target={target} />
		</div>
	);
}
