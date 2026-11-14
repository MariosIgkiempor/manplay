import { type ReactNode, useCallback, useRef, useState } from "react";
import { TagConfirmDialog } from "#/components/tag-confirm-dialog.tsx";

export interface TagConfirmRequest {
	title: string;
	subtitle?: string | undefined;
	/** Songs or folders to write to, each with the edits it would get. */
	items: { path: string; name: string; edits: Record<string, string> }[];
}

/** `ask` resolves to whether the user applied the changes; render `dialog` once in the view. */
export function useTagConfirm(): {
	ask: (req: TagConfirmRequest) => Promise<boolean>;
	dialog: ReactNode;
} {
	const [req, setReq] = useState<TagConfirmRequest | null>(null);
	const resolver = useRef<((ok: boolean) => void) | null>(null);
	const ask = useCallback(
		(r: TagConfirmRequest) =>
			new Promise<boolean>((resolve) => {
				resolver.current?.(false);
				resolver.current = resolve;
				setReq(r);
			}),
		[],
	);
	const finish = useCallback((ok: boolean) => {
		resolver.current?.(ok);
		resolver.current = null;
		setReq(null);
	}, []);
	return { ask, dialog: req && <TagConfirmDialog req={req} onDone={finish} /> };
}
