const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync("settings/features.js", "utf8");

async function setup({ saved = {}, readFails = false, writeFails = false } = {}) {
  const writes = [];
  const toggles = ["youtubeTheaterEnabled", "youtubeFullChatEnabled"].map((setting) => ({
    dataset: { setting },
    checked: false,
    disabled: true,
    addEventListener(_, callback) { this.change = callback; },
  }));
  const status = {
    textContent: "",
    error: false,
    toggleAttribute: (_, value) => { status.error = value; },
  };
  vm.runInNewContext(source, {
    document: {
      querySelectorAll: () => toggles,
      getElementById: () => status,
    },
    chrome: { storage: { local: {
      get: async (defaults) => {
        if (readFails) throw new Error("Read failed");
        return { ...defaults, ...saved };
      },
      set: async (settings) => {
        if (writeFails) throw new Error("Write failed");
        writes.push(JSON.parse(JSON.stringify(settings)));
      },
    } } },
  });
  await new Promise(setImmediate);
  return { toggles, toggle: toggles[0], status, writes };
}

test("settings page loads independent preferences and persists only the changed toggle", async () => {
  const app = await setup({ saved: { youtubeTheaterEnabled: false } });
  assert.equal(app.toggle.disabled, false);
  assert.equal(app.toggle.checked, false);
  assert.equal(app.toggles[1].checked, true);
  app.toggle.checked = true;
  const saving = app.toggle.change();
  assert.equal(app.toggle.disabled, true);
  assert.equal(app.toggles[1].disabled, false);
  await saving;
  assert.deepEqual(app.writes, [{ youtubeTheaterEnabled: true }]);
  assert.equal(app.toggle.disabled, false);
  assert.equal(app.status.error, false);
});

test("the full-chat switch does not change the theater preference", async () => {
  const app = await setup();
  app.toggles[1].checked = false;
  await app.toggles[1].change();
  assert.deepEqual(app.writes, [{ youtubeFullChatEnabled: false }]);
  assert.equal(app.toggle.checked, true);
});

test("settings page keeps both switches disabled if preferences cannot be read", async () => {
  const app = await setup({ readFails: true });
  assert.ok(app.toggles.every((toggle) => toggle.disabled));
  assert.equal(app.status.error, true);
});

test("settings page restores either switch after a failed write", async () => {
  for (const index of [0, 1]) {
    const app = await setup({ writeFails: true });
    const toggle = app.toggles[index];
    toggle.checked = false;
    await toggle.change();
    assert.equal(toggle.checked, true);
    assert.equal(toggle.disabled, false);
    assert.equal(app.status.error, true);
    assert.deepEqual(app.writes, []);
  }
});
