const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const css = readFileSync("features/youtube-theater/style.css", "utf8");

test("native video dimensions are not replaced with percentage sizing", () => {
  // YouTube's relative .html5-video-container has zero height; 100% hides the video.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selector, declarations] of rules) {
    if (selector.includes(".html5-main-video")) {
      assert.doesNotMatch(declarations, /(?:width|height|top|left)\s*:/);
    }
  }
});

test("expanded chat is 400 pixels wide", () => {
  assert.match(css, /\[data-oe-youtube-theater="expanded"\]\s*\{\s*--oe-youtube-chat-width:\s*400px;/);
});
