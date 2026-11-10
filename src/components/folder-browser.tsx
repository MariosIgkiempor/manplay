import { useQuery } from "@tanstack/react-query";
import { Button } from "#/components/ui/button.tsx";
import { driveList } from "#/lib/api.ts";

interface BrowserProps {
	tailnet: string;
	machine: string;
	path: string[];
	setPath: (p: string[]) => void;
	onPick: () => void;
	picking: boolean;
}

export function FolderBrowser({ tailnet, machine, path, setPath, onPick, picking }: BrowserProps) {
	const entries = useQuery({
		queryKey: ["drive", tailnet, machine, path],
		queryFn: () => driveList(tailnet, machine, path),
	});
	const dirs = entries.data?.filter((e) => e.isDir) ?? [];

	return (
		<section className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<nav className="flex flex-wrap items-center gap-1 text-sm">
					<button type="button" className="underline" onClick={() => setPath([])}>
						{machine}
					</button>
					{path.map((seg, i) => (
						<span key={path.slice(0, i + 1).join("/")} className="flex items-center gap-1">
							/
							<button
								type="button"
								className="underline"
								onClick={() => setPath(path.slice(0, i + 1))}
							>
								{seg}
							</button>
						</span>
					))}
				</nav>
				<Button onClick={onPick} disabled={path.length === 0 || picking}>
					Use this folder
				</Button>
			</div>
			{entries.isError && <p className="text-destructive text-sm">{String(entries.error)}</p>}
			<ul className="space-y-0.5">
				{dirs.map((e) => (
					<li key={e.name}>
						<button
							type="button"
							className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
							onClick={() => setPath([...path, e.name])}
						>
							📁 {e.name}
						</button>
					</li>
				))}
			</ul>
			{entries.isSuccess && dirs.length === 0 && (
				<p className="text-muted-foreground text-sm">
					{path.length === 0
						? "No shared folders. On that machine, share one in Tailscale → Settings → Taildrive, and make sure your ACLs allow Taildrive access."
						: "No subfolders here."}
				</p>
			)}
		</section>
	);
}
