import { useId, useState } from "react";
import { ErrorLine, Panel, Section } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { useDiscogsToken, useServices } from "#/lib/queries.ts";

/** Whether songs may be looked up online. Off until switched on, since it sends song names out. */
export function LookupSettings() {
	const services = useServices();
	return (
		<Section title="Tag lookup">
			<Panel className="space-y-2">
				<div className="flex items-center justify-between gap-4">
					<p className="font-medium text-sm">Look up tags on MusicBrainz</p>
					<Switch
						label="Look up tags on MusicBrainz"
						checked={services.isEnabled("lookup", false)}
						onChange={(on) => services.setEnabled("lookup", on)}
					/>
				</div>
				<p className="text-muted-foreground text-xs">
					Sends the title and first artist of the songs you choose to look up to MusicBrainz, a
					public music database, and finds covers in its Cover Art Archive by album name. Nothing is
					sent for any other song.
				</p>
			</Panel>
			<DiscogsToken />
		</Section>
	);
}

/**
 * The Discogs token. With one saved, lookups ask Discogs as well, which knows the label, style
 * and cover of most dance records.
 */
function DiscogsToken() {
	const token = useDiscogsToken();
	const [typed, setTyped] = useState("");
	const inputId = useId();
	const save = () =>
		token.save.mutate(typed, {
			onSuccess: () => setTyped(""),
		});
	return (
		<Panel className="space-y-2">
			<div className="flex items-center justify-between gap-4">
				<label htmlFor={inputId} className="font-medium text-sm">
					Also look on Discogs
				</label>
				{token.saved ? (
					<div className="flex items-center gap-3">
						<span className="text-success text-xs">Token saved</span>
						<Button
							variant="outline"
							size="sm"
							disabled={token.forget.isPending}
							onClick={() => token.forget.mutate()}
						>
							Remove
						</Button>
					</div>
				) : (
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							save();
						}}
					>
						<Input
							id={inputId}
							type="password"
							className="w-60"
							autoComplete="off"
							placeholder="Personal access token"
							value={typed}
							onChange={(e) => setTyped(e.target.value)}
						/>
						<Button type="submit" size="sm" disabled={typed.trim() === "" || token.save.isPending}>
							{token.save.isPending ? "Checking…" : "Save"}
						</Button>
					</form>
				)}
			</div>
			{token.save.isError && <ErrorLine compact>{String(token.save.error)}</ErrorLine>}
			<p className="text-muted-foreground text-xs">
				Adds the style, label and cover Discogs has to what MusicBrainz finds, and sends it the same
				title, artist and album names. Needs a free Discogs account: make a token at
				discogs.com/settings/developers under "Generate new token". It is kept in the keychain and
				sent only to Discogs. Used only while tag lookup is on.
			</p>
		</Panel>
	);
}
