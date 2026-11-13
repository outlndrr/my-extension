const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync("features/youtube-full-chat/content.js", "utf8");

async function setup({ saved = true, readFails = false, deferSettings = false } = {}) {
  const state = { menu: true, selected: 0, clicks: 0, selectOnClick: true };
  const attributes = new Set();
  const options = [0, 1].map((index) => ({
    getAttribute: () => String(state.selected === index),
    click() {
      state.clicks++;
      if (state.selectOnClick) state.selected = index;
    },
  }));
  state.options = options;
  let tick;
  let storageChange;
  let resolveSettings;
  let warnings = 0;
  const settings = new Promise((resolve, reject) => {
    resolveSettings = resolve;
    if (readFails) reject(new Error("Read failed"));
    else if (!deferSettings) resolve({ youtubeFullChatEnabled: saved });
  });
  vm.runInNewContext(source, {
    location: { pathname: "/live_chat" },
    document: {
      documentElement: {
        removeAttribute: (name) => attributes.delete(name),
        toggleAttribute: (name, value) => value ? attributes.add(name) : attributes.delete(name),
      },
      querySelector: () => state.menu ? { querySelectorAll: () => state.options } : null,
    },
    chrome: { storage: {
      local: { get: () => settings },
      onChanged: { addListener: (callback) => { storageChange = callback; } },
    } },
    window: { setInterval: (callback) => { tick = callback; } },
    console: { warn: () => { warnings++; } },
  });
  await new Promise(setImmediate);
  return {
    state, options, tick: () => tick(), resolveSettings,
    hidden: () => attributes.has("data-oe-youtube-full-chat"),
    warnings: () => warnings,
    change: (changes, area = "local") => storageChange(changes, area),
    setting: (value) => storageChange({ youtubeFullChatEnabled: { newValue: value } }, "local"),
  };
}

test("full chat is selected through the native menu and the filtered option is hidden", async () => {
  const app = await setup();
  assert.equal(app.state.selected, 1);
  assert.equal(app.state.clicks, 1);
  assert.equal(app.hidden(), true);
  app.tick();
  assert.equal(app.state.clicks, 1, "Already selected live chat must not be reloaded");
});

test("disable restores both menu choices without forcing a different chat mode", async () => {
  const app = await setup();
  app.setting(false);
  assert.equal(app.hidden(), false);
  assert.equal(app.state.selected, 1);
  app.state.selected = 0;
  app.tick();
  assert.equal(app.state.selected, 0);
  app.setting(true);
  assert.equal(app.state.selected, 1);
  assert.equal(app.hidden(), true);
});

test("saved disabled preference and unrelated settings are respected", async () => {
  const app = await setup({ saved: false });
  assert.equal(app.state.clicks, 0);
  app.change({ youtubeTheaterEnabled: { newValue: true } });
  app.change({ youtubeFullChatEnabled: { newValue: true } }, "sync");
  app.tick();
  assert.equal(app.state.clicks, 0);
  app.setting(undefined);
  assert.equal(app.state.selected, 1, "Removing the preference restores the enabled default");
});

test("late menus and selection resets are handled", async () => {
  const app = await setup({ saved: false });
  app.state.menu = false;
  app.setting(true);
  assert.equal(app.hidden(), false);
  app.state.menu = true;
  app.tick();
  assert.equal(app.hidden(), true);
  app.state.selected = 0;
  app.tick();
  assert.equal(app.state.selected, 1);
});

test("unknown menus are left intact and hiding requires confirmed live selection", async () => {
  const app = await setup({ saved: false });
  for (const count of [0, 1, 3]) {
    app.state.options = Array.from({ length: count }, () => app.options[0]);
    app.setting(true);
    assert.equal(app.state.clicks, 0);
    assert.equal(app.hidden(), false);
  }
  app.state.options = app.options;
  app.state.selectOnClick = false;
  app.tick();
  assert.equal(app.hidden(), false);
  app.state.selectOnClick = true;
  app.tick();
  assert.equal(app.hidden(), true);
});

test("settings errors leave the native chat untouched", async () => {
  const app = await setup({ readFails: true });
  app.tick();
  assert.equal(app.hidden(), false);
  assert.equal(app.state.clicks, 0);
  assert.equal(app.warnings(), 1);
});

test("a late settings read cannot override a new switch value", async () => {
  const app = await setup({ deferSettings: true });
  app.setting(false);
  app.resolveSettings({ youtubeFullChatEnabled: true });
  await new Promise(setImmediate);
  app.tick();
  assert.equal(app.state.clicks, 0);
});

test("replays and unrelated pages do not initialize the feature", () => {
  for (const pathname of ["/live_chat_replay", "/watch", "/"]) {
    assert.doesNotThrow(() => vm.runInNewContext(source, { location: { pathname } }));
  }
});
