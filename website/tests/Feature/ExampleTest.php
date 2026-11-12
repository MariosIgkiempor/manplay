<?php

namespace Tests\Feature;

use App\Services\LatestRelease;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ExampleTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Cache::flush();
    }

    public function test_home_page_links_the_latest_release_dmgs(): void
    {
        Http::fake(['api.github.com/*' => Http::response([
            'tag_name' => 'v1.2.3',
            'html_url' => 'https://github.com/x/y/releases/tag/v1.2.3',
            'assets' => [
                ['name' => 'manplay_1.2.3_aarch64.dmg', 'browser_download_url' => 'https://dl/arm.dmg'],
                ['name' => 'manplay_1.2.3_x64.dmg', 'browser_download_url' => 'https://dl/intel.dmg'],
                ['name' => 'latest.json', 'browser_download_url' => 'https://dl/latest.json'],
            ],
        ])]);

        $this->get('/')
            ->assertOk()
            ->assertSee('https://dl/arm.dmg')
            ->assertSee('https://dl/intel.dmg')
            ->assertSee('Version 1.2.3');
    }

    public function test_home_page_falls_back_to_the_releases_page_when_github_fails(): void
    {
        Http::fake(['api.github.com/*' => Http::response([], 404)]);

        $this->get('/')->assertOk()->assertSee('Download from GitHub')->assertSee('/releases');
    }

    public function test_parse_rejects_payloads_without_a_tag(): void
    {
        $this->assertNull((new LatestRelease)->parse([]));
    }
}
