<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>manplay — music library manager for macOS</title>
    <meta name="description" content="manplay keeps your music library tidy: scan, tag, build playlists, sync to devices and export to Rekordbox.">
    <link rel="icon" type="image/png" href="{{ asset('icon.png') }}">
    <style>
        :root { color-scheme: dark; --bg: #0d0d11; --card: #17171d; --fg: #f5f5f7; --muted: #9b9ba8; --border: #26262f; }
        * { box-sizing: border-box; }
        body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
        .wrap { max-width: 960px; margin: 0 auto; padding: 0 24px; }
        header { display: flex; justify-content: space-between; align-items: center; padding: 24px 0; }
        header a { color: var(--muted); text-decoration: none; font-size: 14px; }
        .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; color: var(--fg) !important; font-size: 16px !important; }
        .brand img { width: 28px; height: 28px; }
        .hero { text-align: center; padding: 72px 0 56px; }
        .hero img { width: 112px; height: 112px; }
        h1 { font-size: clamp(36px, 6vw, 60px); line-height: 1.1; margin: 24px 0 16px; letter-spacing: -0.02em; }
        .lead { color: var(--muted); font-size: 19px; max-width: 560px; margin: 0 auto 32px; }
        .buttons { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
        .btn { display: inline-block; padding: 12px 22px; border-radius: 10px; text-decoration: none; font-weight: 600; background: var(--fg); color: var(--bg); }
        .btn.alt { background: transparent; color: var(--fg); border: 1px solid var(--border); }
        .note { color: var(--muted); font-size: 14px; margin-top: 16px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; padding-bottom: 56px; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 22px; }
        .card h3 { margin: 0 0 6px; font-size: 17px; }
        .card p { margin: 0; color: var(--muted); font-size: 15px; }
        .install { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 24px; margin-bottom: 56px; }
        .install h2 { margin-top: 0; }
        .install li { margin-bottom: 6px; color: var(--muted); }
        code { background: var(--bg); border: 1px solid var(--border); padding: 2px 6px; border-radius: 6px; font-size: 14px; color: var(--fg); }
        footer { border-top: 1px solid var(--border); padding: 28px 0; color: var(--muted); font-size: 14px; text-align: center; }
        footer a { color: var(--muted); }
    </style>
</head>
<body>
<div class="wrap">
    <header>
        <a class="brand" href="{{ route('home') }}"><img src="{{ asset('icon.png') }}" alt="">manplay</a>
        <a href="https://github.com/{{ \App\Services\LatestRelease::REPO }}">GitHub</a>
    </header>

    <section class="hero">
        <img src="{{ asset('icon.png') }}" alt="manplay icon">
        <h1>Your music library,<br>under control.</h1>
        <p class="lead">Scan a folder, fix tags, build playlists, sync to your devices and export to Rekordbox. Fast, local and native on macOS.</p>
        <div class="buttons">
            @if ($release['arm64'])
                <a class="btn" href="{{ $release['arm64'] }}">Download for Apple Silicon</a>
            @endif
            @if ($release['x64'])
                <a class="btn alt" href="{{ $release['x64'] }}">Download for Intel</a>
            @endif
            @unless ($release['arm64'] || $release['x64'])
                <a class="btn" href="{{ $release['url'] }}">Download from GitHub</a>
            @endunless
        </div>
        <p class="note">
            @if ($release['version'])
                Version {{ $release['version'] }} ·
            @endif
            macOS 11 or later · free
        </p>
    </section>

    <section class="grid">
        <div class="card"><h3>Library</h3><p>Scan folders, browse by artist and album, edit tags in bulk and keep renamed files tracked.</p></div>
        <div class="card"><h3>Import</h3><p>Pull new music out of your downloads, including zips, with an editable artist and album preview.</p></div>
        <div class="card"><h3>Sync</h3><p>Push playlists and tracks to devices and WebDAV targets, with progress and history.</p></div>
        <div class="card"><h3>Rekordbox</h3><p>Export your library and playlists as Rekordbox XML, kept current automatically.</p></div>
    </section>

    <section class="install">
        <h2>Install</h2>
        <ol>
            <li>Open the downloaded <code>.dmg</code> and drag manplay to Applications.</li>
            <li>The app is not notarized yet. On first launch, right-click it and choose <strong>Open</strong>, or run <code>xattr -cr /Applications/manplay.app</code>.</li>
            <li>After that, manplay checks for updates itself (Settings → About).</li>
        </ol>
    </section>

    <footer>
        <a href="{{ $release['url'] }}">Release notes</a> · <a href="https://github.com/{{ \App\Services\LatestRelease::REPO }}">Source</a>
    </footer>
</div>
</body>
</html>
