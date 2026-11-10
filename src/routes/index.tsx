import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import { listTracks, pickAndScan } from "#/lib/api.ts";

export const Route = createFileRoute("/")({ component: Library });

function Library() {
	const queryClient = useQueryClient();
	const tracks = useQuery({ queryKey: ["tracks"], queryFn: listTracks });
	const scan = useMutation({
		mutationFn: pickAndScan,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tracks"] }),
	});

	const rows = tracks.data ?? [];

	return (
		<main className="mx-auto max-w-6xl space-y-4 p-6">
			<header className="flex items-center justify-between">
				<h1 className="font-semibold text-xl">Library ({rows.length})</h1>
				<Button onClick={() => scan.mutate()} disabled={scan.isPending}>
					{scan.isPending ? "Scanning…" : "Scan folder"}
				</Button>
			</header>
			{scan.isError && <p className="text-destructive text-sm">{String(scan.error)}</p>}
			<Table className="table-fixed">
				<TableHeader>
					<TableRow>
						<TableHead>Artist</TableHead>
						<TableHead>Album</TableHead>
						<TableHead>Title</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.length === 0 ? (
						<TableRow>
							<TableCell colSpan={3} className="text-muted-foreground">
								No tracks yet.
							</TableCell>
						</TableRow>
					) : (
						rows.map((t) => (
							<TableRow key={t.id}>
								<TableCell className="truncate" title={t.artist}>
									{t.artist}
								</TableCell>
								<TableCell className="truncate" title={t.album}>
									{t.album}
								</TableCell>
								<TableCell className="truncate" title={t.title}>
									{t.title}
								</TableCell>
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
		</main>
	);
}
