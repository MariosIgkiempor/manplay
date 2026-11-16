# app

A minimal TanStack Start app with one route and plain CSS.

```bash
pnpm install
pnpm dev
```

Edit `src/routes/index.tsx` to get started. Add route files under
`src/routes`; TanStack Router updates `src/routeTree.gen.ts` for you.

Build the production app with:

```bash
pnpm build
```


## ffmpeg

The app ships its own static ffmpeg (a Tauri sidecar, GPL v3) for converting songs to MP3. `pnpm install` downloads it for this machine into
`src-tauri/binaries/` (checked against a pinned SHA-256); `pnpm ffmpeg <target triple>` fetches
another target's. Builds and hashes live in `scripts/fetch-ffmpeg.mjs`.

## Windows

Builds and runs on Windows 10/11 (x64). To develop there, install Rust (MSVC toolchain),
Node 22 + pnpm, and Perl ([Strawberry Perl](https://strawberryperl.com); the bundled
SQLCipher builds OpenSSL from source). Then `pnpm install && pnpm tauri dev`.

Differences from macOS: USB sticks have no Recycle Bin, so resetting a drive deletes for good;
AIFF and ALAC songs (which WebView2 cannot decode) stream through the `pcm://` scheme, decoded
as they play. Set `MANPLAY_PCM=1` to use that path on a Mac too.

## Releasing

1. Bump nothing by hand: the version comes from the git tag.
2. `git tag v0.2.0 && git push origin v0.2.0`
3. The `Release` workflow builds Apple Silicon and Intel DMGs and a Windows installer
   (`*-setup.exe`), signs the updater artifacts, and publishes a GitHub release with
   `latest.json`. The Windows installer is not code-signed yet, so SmartScreen warns on first run.
4. Installed apps pick it up via Settings → About (checked on launch too), and the
   website (separate repo `manplay-web`, Laravel) links the new DMGs automatically (the Windows `.exe` needs a link there too) (10 min cache).

Required repo secrets: `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/manplay.key`)
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty string if none).
