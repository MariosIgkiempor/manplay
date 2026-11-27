import { Trash2 } from "lucide-react";
import { ErrorLine } from "#/components/page.tsx";
import { SettingRow, SettingRows } from "#/components/setting-row.tsx";
import { ConfirmButton } from "#/components/ui/confirm-button.tsx";
import { Select, type SelectOption } from "#/components/ui/select.tsx";
import { GB, type NewSongs, newSongsSchema } from "#/lib/api.ts";
import { formatBytes } from "#/lib/format.ts";
import { useNewSharedSongs, useStreamCache } from "#/lib/queries.ts";

const NEW_SONGS: readonly SelectOption[] = [
	{
		value: "stream",
		label: "Stream",
		hint: "Listed and played from the destination; kept on request",
	},
	{ value: "download", label: "Download", hint: "Downloaded into the library folder" },
];

/** Cache sizes offered, in GB. */
const SIZES_GB = [1, 2, 5, 10, 20, 50, 100, 250, 500] as const;

/** The sizes offered, with the one set now when it is none of them. */
export function cacheSizeOptions(limit: number): SelectOption[] {
	const sizes = SIZES_GB.map((n) => n * GB);
	const all = sizes.includes(limit) ? sizes : [...sizes, limit].sort((a, b) => a - b);
	return all.map((bytes) => ({ value: String(bytes), label: formatBytes(bytes) }));
}

/**
 * How this device streams a shared library kept on a destination: whether songs other devices add
 * are streamed or downloaded, and the cache that keeps played songs for replays.
 */
export function StreamingSettings() {
	const { choice, save } = useNewSharedSongs();
	const { usage, resize, empty } = useStreamCache();
	const cache = usage.data;
	const error = save.error ?? resize.error ?? empty.error;
	return (
		<SettingRows title="Streaming">
			<SettingRow label="Songs other devices add">
				<Select
					label="Songs other devices add"
					value={choice.data ?? "stream"}
					options={NEW_SONGS}
					onChange={(next) => {
						const parsed = newSongsSchema.safeParse(next);
						if (parsed.success) {
							save.mutate(parsed.data satisfies NewSongs);
						}
					}}
				/>
			</SettingRow>
			<SettingRow label="Stream cache size">
				{cache && (
					<Select
						label="Stream cache size"
						value={String(cache.limit)}
						options={cacheSizeOptions(cache.limit)}
						onChange={(next) => resize.mutate(Number(next))}
					/>
				)}
			</SettingRow>
			<SettingRow
				label={
					cache
						? `Stream cache: ${formatBytes(cache.used)} of ${formatBytes(cache.limit)}`
						: "Stream cache"
				}
			>
				<ConfirmButton
					variant="ghost"
					size="sm"
					disabled={!cache || cache.used === 0 || empty.isPending}
					confirmLabel="Empty the stream cache"
					consequence="Played songs stream from the destination again. Kept songs stay."
					onConfirm={() => empty.mutate()}
				>
					<Trash2 />
					Empty cache
				</ConfirmButton>
			</SettingRow>
			{error && <ErrorLine compact>{String(error)}</ErrorLine>}
		</SettingRows>
	);
}
