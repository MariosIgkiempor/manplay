import { useState } from "react";
import { FilePane, type FsClipboard } from "#/components/file-pane.tsx";
import { useLibraryRoot } from "#/lib/queries.ts";

/** Two-pane file manager over the library folder. */
export function FilesView() {
	const root = useLibraryRoot();
	const [split, setSplit] = useState(false);
	const [clipboard, setClipboard] = useState<FsClipboard | null>(null);
	const [active, setActive] = useState<0 | 1>(0);
	// Per-pane folder; `null` means "the library root".
	const [paths, setPaths] = useState<[string | null, string | null]>([null, null]);

	if (root.data === undefined || root.data === null) {
		return (
			<div className="p-6">
				<p className="text-muted-foreground text-sm">
					{root.isSuccess ? "Choose a library folder in Library first." : "Loading…"}
				</p>
			</div>
		);
	}
	const base = root.data;
	const at = (i: 0 | 1) => paths[i] ?? base;
	const go = (i: 0 | 1) => (p: string) =>
		setPaths((prev) => (i === 0 ? [p, prev[1]] : [prev[0], p]));
	const toggleSplit = () => {
		if (split) {
			setActive(0);
		} else {
			setPaths(([a]) => [a, a]);
		}
		setSplit(!split);
	};
	const panes: (0 | 1)[] = split ? [0, 1] : [0];

	return (
		<div className="flex h-full min-h-0 border-t">
			{panes.map((i) => (
				<FilePane
					key={i}
					root={base}
					path={at(i)}
					onNavigate={go(i)}
					active={split && active === i}
					onActivate={() => setActive(i)}
					clipboard={clipboard}
					setClipboard={setClipboard}
					onToggleSplit={toggleSplit}
					otherPath={split ? at(i === 0 ? 1 : 0) : null}
				/>
			))}
		</div>
	);
}
