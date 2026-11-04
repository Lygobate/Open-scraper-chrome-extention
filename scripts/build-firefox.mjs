#!/usr/bin/env node
// Builds the Firefox package from the Chrome sources (manifest.json stays untouched).
// Usage: node scripts/build-firefox.mjs  ->  dist/firefox/ + dist/open-scraper-firefox-<version>.zip
import { cp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GECKO_ID = "open-scraper@lygobate";
const GECKO_MIN_VERSION = "140.0"; // first Firefox desktop release that knows data_collection_permissions
const INCLUDE = ["_locales", "css", "fonts", "js", "src", "icon16.png", "icon32.png", "icon64.png", "icon128.png", "options_bg.png", "PRIVACY.md"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const out = join(dist, "firefox");

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));

// Derive the Firefox manifest from the Chrome one.
const { update_url, incognito, background, ...rest } = manifest;
const firefoxManifest = {
    ...rest,
    background: { scripts: [background.service_worker] },
    browser_specific_settings: {
        gecko: {
            id: GECKO_ID,
            strict_min_version: GECKO_MIN_VERSION,
            data_collection_permissions: { required: ["none"] }
        }
    }
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of INCLUDE) {
    try { await stat(join(root, name)); } catch { continue; }
    await cp(join(root, name), join(out, name), { recursive: true });
}
await writeFile(join(out, "manifest.json"), JSON.stringify(firefoxManifest, null, 2) + "\n");

const zip = join(dist, `open-scraper-firefox-${manifest.version}.zip`);
await rm(zip, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zip, "."], { cwd: out });

console.log(`Firefox package: ${zip}`);
