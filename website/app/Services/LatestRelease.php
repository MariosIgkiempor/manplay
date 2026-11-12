<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * Looks up the latest manplay GitHub release and picks the macOS DMGs out of its assets.
 * Cached so the page never hits the GitHub API per visit, and degrades to the releases page.
 */
class LatestRelease
{
    public const REPO = 'MariosIgkiempor/manplay';

    /** @return array{version: string|null, url: string, arm64: string|null, x64: string|null} */
    public function get(): array
    {
        return Cache::remember('latest-release', now()->addMinutes(10), fn () => $this->fetch());
    }

    /** @return array{version: string|null, url: string, arm64: string|null, x64: string|null} */
    private function fetch(): array
    {
        $fallback = [
            'version' => null,
            'url' => 'https://github.com/'.self::REPO.'/releases',
            'arm64' => null,
            'x64' => null,
        ];

        try {
            $response = Http::timeout(5)
                ->acceptJson()
                ->withHeaders(['User-Agent' => 'manplay-website'])
                ->get('https://api.github.com/repos/'.self::REPO.'/releases/latest');
        } catch (Throwable) {
            return $fallback;
        }

        if (! $response->successful()) {
            return $fallback;
        }

        return $this->parse($response->json()) ?? $fallback;
    }

    /**
     * @param  array<string, mixed>  $release
     * @return array{version: string|null, url: string, arm64: string|null, x64: string|null}|null
     */
    public function parse(array $release): ?array
    {
        if (! isset($release['tag_name'], $release['html_url'])) {
            return null;
        }

        $dmg = fn (string $arch): ?string => collect($release['assets'] ?? [])
            ->first(fn (array $a) => str_ends_with($a['name'] ?? '', '.dmg') && str_contains($a['name'], $arch))
            ['browser_download_url'] ?? null;

        return [
            'version' => ltrim($release['tag_name'], 'v'),
            'url' => $release['html_url'],
            'arm64' => $dmg('aarch64'),
            'x64' => $dmg('x64'),
        ];
    }
}
