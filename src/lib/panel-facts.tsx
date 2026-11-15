import { Clock, Disc3, ListMusic } from "lucide-react";
import type { Fact } from "#/components/panel-header.tsx";
import type { Track } from "#/lib/api.ts";
import { duration } from "#/lib/format.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many songs, and how long they play together. */
export function songFacts(tracks: readonly Track[]): Fact[] {
	const seconds = tracks.reduce((n, t) => n + (t.durationMs ?? 0), 0) / 1000;
	const facts: Fact[] = [
		{
			icon: <ListMusic />,
			label: String(tracks.length),
			title: plural(tracks.length, "song", "songs"),
		},
	];
	if (seconds >= 1) {
		facts.push({ icon: <Clock />, label: duration(seconds), title: "Total length" });
	}
	return facts;
}

export function albumFact(count: number): Fact {
	return { icon: <Disc3 />, label: String(count), title: plural(count, "album", "albums") };
}
