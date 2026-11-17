const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");

test("manifest uses matching, correctly sized PNG icons for the app and toolbar", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
  for (const [size, file] of Object.entries(manifest.icons)) {
    const png = readFileSync(file);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.subarray(12, 16).toString(), "IHDR");
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
});

test("extension pages use the sage design and local assets with no missing references", () => {
  for (const file of ["popup/index.html", "settings/index.html"]) {
    const html = readFileSync(file, "utf8");
    assert.match(html, /<html lang="ru" data-theme="sage">/);
    assert.match(html, /assets\/brand\/cat\.jpg/);
    for (const [, reference] of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
      assert.doesNotMatch(reference, /^https?:/, "UI resources must be bundled");
      assert.ok(readFileSync(path.join(path.dirname(file), reference)).length > 0, reference);
    }
  }
  const css = readFileSync("popup/style.css", "utf8");
  assert.match(css, /color-scheme: dark;/);
  assert.match(css, /--sig: #a7bfa0;/);
  assert.match(css, /body\s*\{[^}]*font: inherit;/, "override Chromium extension pages\u0027 default body font");
  assert.doesNotMatch(css, /light-dark\(/);
  const fonts = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)];
  assert.equal(fonts.length, 2);
  for (const [, file] of fonts) {
    assert.equal(readFileSync(path.join("popup", file)).subarray(0, 4).toString(), "wOF2");
  }
});
