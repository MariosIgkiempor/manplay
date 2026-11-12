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


## Releasing

1. Bump nothing by hand: the version comes from the git tag.
2. `git tag v0.2.0 && git push origin v0.2.0`
3. The `Release` workflow builds Apple Silicon and Intel DMGs, signs the updater
   artifacts, and publishes a GitHub release with `latest.json`.
4. Installed apps pick it up via Settings → About (checked on launch too), and the
   website (`website/`, Laravel) links the new DMGs automatically (10 min cache).

Required repo secrets: `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/manplay.key`)
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty string if none).
