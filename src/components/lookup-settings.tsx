import { KeyRound } from "lucide-react";
import { useId, useState } from "react";
import { BrandGlyph } from "#/components/brand-icon.tsx";
import { FieldRow, FrameSection } from "#/components/frame.tsx";
import { ErrorLine } from "#/components/page.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Fact, Facts } from "#/components/ui/facts.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { useDiscogsToken, useServices } from "#/lib/queries.ts";

/** Whether songs may be looked up online. Off until switched on, since it sends song names out. */
export function LookupSettings() {
	const services = useServices();
	const switchId = useId();
	return (
		<FrameSection
			title="Tag lookup"
			titleHidden
			description={
				<Facts label="Find missing tags and covers online, only for songs you choose.">
					<Fact tone="sent">Only songs you choose</Fact>
				</Facts>
			}
		>
			<FieldRow
				label={
					<span className="flex items-center gap-2">
						<BrandGlyph brand="musicbrainz" />
						Look up tags on MusicBrainz
					</span>
				}
				htmlFor={switchId}
				description={
					<Facts label="Sends title and first artist to MusicBrainz, a public music database. Covers come from its Cover Art Archive by album name.">
						<Fact tone="sent">Title</Fact>
						<Fact tone="sent">First artist</Fact>
						<Fact tone="sent">Album, for covers</Fact>
					</Facts>
				}
				align="center"
			>
				<Switch
					id={switchId}
					label="Look up tags on MusicBrainz"
					checked={services.isEnabled("lookup", false)}
					onChange={(on) => services.setEnabled("lookup", on)}
				/>
			</FieldRow>
			<DiscogsToken />
		</FrameSection>
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
		<FieldRow
			label={
				<span className="flex items-center gap-2">
					<BrandGlyph brand="discogs" />
					Also look on Discogs
				</span>
			}
			htmlFor={token.saved ? undefined : inputId}
			description={
				<Facts label="Adds style, label and cover from Discogs. Make a free token at discogs.com/settings/developers. It stays in the keychain and goes only to Discogs.">
					<Fact tone="changed">Style</Fact>
					<Fact tone="changed">Label</Fact>
					<Fact tone="changed">Cover</Fact>
					<Fact icon={<KeyRound />} hint="Make a free token at discogs.com/settings/developers">
						discogs.com/settings/developers
					</Fact>
					<Fact tone="kept" hint="Kept in the keychain and sent only to Discogs">
						Keychain
					</Fact>
				</Facts>
			}
			align={token.saved ? "center" : "start"}
		>
			{token.saved ? (
				<>
					<span className="text-success text-sm">Token saved</span>
					<Button
						variant="outline"
						size="sm"
						disabled={token.forget.isPending}
						onClick={() => token.forget.mutate()}
					>
						Remove
					</Button>
				</>
			) : (
				<form
					className="flex w-full items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<Input
						id={inputId}
						type="password"
						autoComplete="off"
						placeholder="Personal access token"
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
					/>
					<Button
						type="submit"
						variant="outline"
						disabled={typed.trim() === "" || token.save.isPending}
					>
						{token.save.isPending ? "Checking…" : "Save"}
					</Button>
				</form>
			)}
			{token.save.isError && <ErrorLine compact>{String(token.save.error)}</ErrorLine>}
		</FieldRow>
	);
}
