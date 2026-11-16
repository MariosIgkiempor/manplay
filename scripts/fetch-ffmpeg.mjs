// Downloads the static ffmpeg that ships inside the app (a Tauri sidecar) to
// src-tauri/binaries/ffmpeg-<target triple>[.exe], checking its SHA-256.
//
//   node scripts/fetch-ffmpeg.mjs                       # for this machine
//   node scripts/fetch-ffmpeg.mjs x86_64-apple-darwin   # for another target
//
// Builds: https://github.com/eugeneware/ffmpeg-static (GPL v3, with libmp3lame).
// To upgrade, change RELEASE and the hashes (sha256 of the .gz assets).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const RELEASE = "b6.1.1";
const BUILDS = {
	"aarch64-apple-darwin": {
		asset: "darwin-arm64",
		sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
	},
	"x86_64-apple-darwin": {
		asset: "darwin-x64",
		sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
	},
	"x86_64-pc-windows-msvc": {
		asset: "win32-x64",
		sha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
	},
};

function hostTriple() {
	const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
	const line = out.split("\n").find((l) => l.startsWith("host:"));
	if (!line) throw new Error("could not read the host target from `rustc -vV`");
	return line.slice("host:".length).trim();
}

async function download(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const triple = process.argv[2] ?? hostTriple();
const build = BUILDS[triple];
if (!build) {
	process.stderr.write(
		`No bundled ffmpeg for ${triple}. Known: ${Object.keys(BUILDS).join(", ")}\n`,
	);
	process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "binaries");
const exe = triple.includes("windows") ? ".exe" : "";
const dest = join(dir, `ffmpeg-${triple}${exe}`);
const stamp = `${dest}.sha256`;

if (existsSync(dest) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === build.sha256) {
	process.stdout.write(`ffmpeg for ${triple} is up to date\n`);
	process.exit(0);
}

const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;
process.stdout.write(`Downloading ffmpeg ${RELEASE} for ${triple}…\n`);
const gz = await download(`${base}/ffmpeg-${build.asset}.gz`);
const got = sha256(gz);
if (got !== build.sha256) {
	throw new Error(`ffmpeg-${build.asset}.gz: expected sha256 ${build.sha256}, got ${got}`);
}
const license = await download(`${base}/${build.asset}.LICENSE`);

mkdirSync(dir, { recursive: true });
writeFileSync(dest, gunzipSync(gz));
chmodSync(dest, 0o755);
writeFileSync(join(dir, "FFMPEG-LICENSE.txt"), license);
writeFileSync(stamp, `${build.sha256}\n`);
process.stdout.write(`Wrote ${dest}\n`);
