# Open Scraper

Browser extension (Chrome + Firefox, one MV3 `manifest.json`). Public repo, MIT.

## Git
- `develop` = integration; feature/fix branch → PR to `develop`. `main` = releases only.
- Commits in English, one logical change each, `git add` specific files. Never force-push.
- Never name other scraping products in code, commits, branches or PRs.

## Key files
- `src/popup.*`: main window (Extract list: table detection, crawl, grid, export).
- `src/details.*`: Extract details tab (picked fields, per-page run).
- `src/onload.js` (+ `.css`): content script injected in pages (table finder, picker highlight).
- `src/background.js`: service worker; `src/options/`: settings page; `js/`: vendored libs (don't edit).

## Packaging
- `node scripts/package.mjs` → `dist/open-scraper-<version>.zip`, the one zip for both stores.
- Only its `INCLUDE` list is shipped: new runtime files must be added there; `scripts/`, `docs/`, `CLAUDE.md` stay out.

## Test builds
`scripts/test-builds/build.sh [out-dir] [branch...]` (default out-dir `../open-scraper-test`) builds two unpacked packages to load side by side:
- `develop/` = origin/develop, blue icons, name "Open Scraper (develop)".
- `current/` = origin/develop + listed branches merged, orange icons, "Open Scraper (current)".
- Branch list: arguments, else `scripts/test-builds/branches.local` (gitignored, one per line). Branches must be pushed.
- Icons are committed in `scripts/test-builds/icons/{develop,current}/`; never commit tinted icons or a renamed manifest at the root.
- Builds from origin/* in a temp worktree (checkout untouched); stops on a merge conflict. Then reload both extensions.
