#!/usr/bin/env node
// Builds the single zip uploaded to both the Chrome Web Store and addons.mozilla.org.
// Usage: node scripts/package.mjs  ->  dist/open-scraper-<version>.zip
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INCLUDE = ["manifest.json", "_locales", "css", "fonts", "js", "src", "icon16.png", "icon32.png", "icon64.png", "icon128.png", "options_bg.png", "PRIVACY.md"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));

const files = [];
for (const name of INCLUDE) {
    try { await stat(join(root, name)); files.push(name); } catch { console.warn(`Skipped (missing): ${name}`); }
}

const dist = join(root, "dist");
const zip = join(dist, `open-scraper-${version}.zip`);
await mkdir(dist, { recursive: true });
await rm(zip, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zip, ...files, "-x", "*.DS_Store"], { cwd: root });

console.log(`Package: ${zip}`);
