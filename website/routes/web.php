<?php

use App\Services\LatestRelease;
use Illuminate\Support\Facades\Route;

Route::get('/', fn (LatestRelease $release) => view('home', ['release' => $release->get()]))->name('home');
