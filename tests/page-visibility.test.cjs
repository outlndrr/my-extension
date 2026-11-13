const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const tick = () => new Promise(setImmediate);

test("injected script reports a visible, focused page and swallows window/document visibility events", () => {
  class Document {}
  const document = new Document();
  const listeners = {};
  const window = { addEventListener(type, listener, capture) { listeners[type] = { listener, capture }; } };
  vm.runInNewContext(readFileSync("features/page-visibility/inject.js", "utf8"), { Document, document, window });

  assert.equal(document.hidden, false);
  assert.equal(document.visibilityState, "visible");
  assert.equal(document.webkitHidden, false);
  assert.equal(document.hasFocus(), true);
  for (const [type, target] of [["visibilitychange", document], ["webkitvisibilitychange", document],
    ["blur", window], ["focus", window]]) {
    assert.equal(listeners[type].capture, true);
    let stopped = false;
    listeners[type].listener({ target, stopImmediatePropagation() { stopped = true; } });
    assert.ok(stopped, `${type} must not reach the page`);
  }
  let stopped = false;
  listeners.blur.listener({ target: { tagName: "INPUT" }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, false, "element blur must keep working for forms");
});

test("background registers the MAIN-world script by default and follows the switch", async () => {
  const calls = [];
  const saved = {};
  let registered = false;
  let onChanged;
  const chrome = {
    storage: {
      local: { async get(defaults) { return { ...defaults, ...saved }; } },
      onChanged: { addListener(listener) { onChanged = listener; } },
    },
    scripting: {
      async getRegisteredContentScripts() { return registered ? [{ id: "page-visibility" }] : []; },
      async registerContentScripts([script]) { calls.push(["register", script]); registered = true; },
      async updateContentScripts([script]) { calls.push(["update", script]); },
      async unregisterContentScripts() { calls.push(["unregister"]); registered = false; },
    },
  };
  vm.runInNewContext(readFileSync("features/page-visibility/background.js", "utf8"), { chrome, console });
  await tick();
  const [[type, script]] = calls;
  assert.equal(type, "register");
  assert.equal(script.world, "MAIN");
  assert.equal(script.runAt, "document_start");
  assert.equal(script.allFrames, true);
  assert.ok(existsSync(script.js[0]));

  saved.pageVisibilityEnabled = false;
  onChanged({ youtubeTheaterEnabled: { newValue: false } }, "local");
  await tick();
  assert.equal(calls.length, 1, "unrelated settings are ignored");
  onChanged({ pageVisibilityEnabled: { newValue: false } }, "local");
  onChanged({ pageVisibilityEnabled: { newValue: false } }, "local");
  await tick();
  assert.deepEqual(calls.slice(1).map(([name]) => name), ["unregister"], "serialized: second sync sees it unregistered");

  saved.pageVisibilityEnabled = true;
  onChanged({ pageVisibilityEnabled: { newValue: true } }, "local");
  onChanged({ pageVisibilityEnabled: { newValue: true } }, "local");
  await tick();
  assert.deepEqual(calls.slice(2).map(([name]) => name), ["register", "update"]);
});

test("service worker entry loads both background features", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const loaded = [];
  vm.runInNewContext(readFileSync(manifest.background.service_worker, "utf8"), {
    importScripts: (...paths) => loaded.push(...paths),
  });
  assert.deepEqual(loaded, ["features/proxy/background.js", "features/page-visibility/background.js"]);
  assert.ok(loaded.every((path) => existsSync(path)));
  assert.ok(manifest.permissions.includes("scripting"));
});
