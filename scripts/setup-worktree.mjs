// Gets a new git worktree ready to build without starting from cold:
//   1. clones the main checkout's Rust build output (src-tauri/target/debug), so only the
//      manplay crate itself recompiles instead of every dependency;
//   2. copies the bundled ffmpeg, so `pnpm install` doesn't download it again;
//   3. runs `pnpm install`.
//
//   node scripts/setup-worktree.mjs      # run from inside the new worktree
//
// The clone uses APFS copy-on-write (`cp -c`) on macOS: it takes seconds and no extra disk space
// until the two copies diverge. Elsewhere a full copy of tens of GB would cost more than it
// saves, so the target is left alone there.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const worktreeRoot = resolve(git("rev-parse", "--show-toplevel"));
const mainCheckoutRoot = resolve(
	dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir")),
);

if (worktreeRoot === mainCheckoutRoot) {
	process.stdout.write("This is the main checkout, not a worktree: nothing to set up.\n");
	process.exit(0);
}

const log = (message) => process.stdout.write(`setup-worktree: ${message}\n`);

function cloneRustTarget() {
	const source = join(mainCheckoutRoot, "src-tauri", "target", "debug");
	const destination = join(worktreeRoot, "src-tauri", "target", "debug");
	if (!existsSync(source)) {
		log(`no build output at ${source} yet; the first build here starts cold`);
		return;
	}
	if (existsSync(destination)) {
		log(`${destination} already exists; leaving it`);
		return;
	}
	if (process.platform !== "darwin") {
		log("not on macOS (no copy-on-write clone); the first build here starts cold");
		return;
	}
	mkdirSync(dirname(destination), { recursive: true });
	log(`cloning ${source} (copy-on-write)…`);
	const startedAt = Date.now();
	execFileSync("cp", ["-c", "-R", source, destination], { stdio: "inherit" });
	log(`cloned in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

function copyBundledFfmpeg() {
	const source = join(mainCheckoutRoot, "src-tauri", "binaries");
	const destination = join(worktreeRoot, "src-tauri", "binaries");
	if (!existsSync(source)) return;
	mkdirSync(destination, { recursive: true });
	for (const name of readdirSync(source)) {
		const target = join(destination, name);
		if (existsSync(target)) continue;
		cpSync(join(source, name), target);
		log(`copied ${name}`);
	}
}

cloneRustTarget();
copyBundledFfmpeg();
execFileSync("pnpm", ["install", "--frozen-lockfile"], {
	cwd: worktreeRoot,
	stdio: "inherit",
	shell: process.platform === "win32",
});
