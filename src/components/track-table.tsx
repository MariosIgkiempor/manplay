import type { ReactNode } from "react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table.tsx";
import type { Track } from "#/lib/api.ts";

interface Props {
	tracks: Track[];
	selected?: ReadonlySet<number>;
	onToggle?: (id: number) => void;
	renderAction?: (track: Track) => ReactNode;
}

export function TrackTable({ tracks, selected, onToggle, renderAction }: Props) {
	const selectable = selected !== undefined && onToggle !== undefined;
	const cols = 3 + (selectable ? 1 : 0) + (renderAction ? 1 : 0);

	return (
		<Table className="table-fixed">
			<TableHeader>
				<TableRow>
					{selectable && <TableHead className="w-8" />}
					<TableHead>Artist</TableHead>
					<TableHead>Album</TableHead>
					<TableHead>Title</TableHead>
					{renderAction && <TableHead className="w-24" />}
				</TableRow>
			</TableHeader>
			<TableBody>
				{tracks.length === 0 ? (
					<TableRow>
						<TableCell colSpan={cols} className="text-muted-foreground">
							No tracks.
						</TableCell>
					</TableRow>
				) : (
					tracks.map((t) => (
						<TableRow key={t.id}>
							{selectable && (
								<TableCell>
									<input
										type="checkbox"
										aria-label={`Select ${t.title}`}
										checked={selected.has(t.id)}
										onChange={() => onToggle(t.id)}
									/>
								</TableCell>
							)}
							<TableCell className="truncate" title={t.artist}>
								{t.artist}
							</TableCell>
							<TableCell className="truncate" title={t.album}>
								{t.album}
							</TableCell>
							<TableCell className="truncate" title={t.title}>
								{t.title}
							</TableCell>
							{renderAction && <TableCell>{renderAction(t)}</TableCell>}
						</TableRow>
					))
				)}
			</TableBody>
		</Table>
	);
}
