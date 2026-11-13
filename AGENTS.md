# Repository Guidelines

## Project Structure & Module Organization

This is a build-free Chromium Manifest V3 extension. `manifest.json` declares permissions, the popup, settings page, and content scripts. `background.js` loads the service worker modules. Keep independent features under `features/`: `proxy/`, `page-visibility/`, `youtube-theater/`, and `youtube-full-chat/`. The shared options UI lives in `settings/`, the toolbar UI in `popup/`, and automated tests in `tests/`. Add a new feature in its own directory and register its scripts or permissions in the manifest where needed.

## Build, Test, and Development Commands

- `npm test` runs all tests with Node's built-in test runner. Use Node.js 22 or newer; no package installation or build step is required.
- `node --test tests/proxy.test.cjs` runs one test file while developing.
- For a browser check, open `chrome://extensions`, enable Developer mode, and load this repository's root as an unpacked extension. Reload the extension after code changes, then refresh affected pages such as YouTube.

## Coding Style & Naming Conventions

Use plain JavaScript and CSS, matching the surrounding files: two-space indentation, double-quoted strings, semicolons, and `camelCase` for variables and functions. Name feature directories and test files in kebab case, for example `features/page-visibility/` and `tests/page-visibility.test.cjs`. Keep browser scripts dependency-free and scoped to their feature. There is no configured formatter or linter; review formatting against nearby code.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`; files end in `.test.cjs`. Add or update focused tests in `tests/` for behavior changes, especially storage, proxy control, and feature toggles. Run `npm test` before submitting. Browser behavior that depends on the live YouTube DOM or Chromium APIs also needs a manual check in a loaded extension; the README lists scenarios.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects that name the affected feature, such as `fix(proxy): stop authentication retries`. In pull requests, describe the behavior change, how it was tested, and any new permissions or storage changes. Link a related issue when one exists; include screenshots for popup, settings, or YouTube UI changes.

## Security & Configuration

Proxy credentials are stored in `chrome.storage.local`. Never commit real credentials or test with personal proxy details. Review any change to `<all_urls>`, proxy permissions, or network requests for its privacy impact.
