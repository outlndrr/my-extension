const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const source = readFileSync("popup/popup.js", "utf8");
const tick = () => new Promise(setImmediate);
const clone = (value) => JSON.parse(JSON.stringify(value));

async function setup({ active = true, control, value, proxyFails = false, readProxy } = {}) {
  const elements = Object.fromEntries(["proxy-status"].map((id) => [id, { textContent: "", title: "", dataset: {} }]));
  const effective = {
    levelOfControl: control || (active ? "controlled_by_this_extension" : "controllable_by_this_extension"),
    value: value || (active
      ? { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "proxy.example.com", port: 8080 } } }
      : { mode: "system" }),
  };
  const requests = [];
  const reads = [];
  const changeListeners = [];
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id] },
    fetch: async (url) => { requests.push(url); throw new Error("Unexpected network request"); },
    // No runtime or storage API: the popup must not read saved proxy credentials.
    chrome: {
      proxy: { settings: {
        onChange: { addListener(listener) { changeListeners.push(listener); } },
        async get(options) {
          reads.push(clone(options));
          if (proxyFails) throw new Error("Proxy API failed");
          return readProxy ? readProxy(clone(effective), reads.length) : clone(effective);
        },
      } },
    },
  });
  await tick();
  return {
    elements, effective, requests, reads,
    async change() {
      for (const listener of changeListeners) listener(clone(effective));
      await tick();
    },
  };
}

test("popup shows only the connection status, never the proxy host, without network requests", async () => {
  for (const host of ["proxy.example.com", "2001:db8::1"]) {
    const app = await setup({ value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host, port: 1080 } } } });
    assert.equal(app.elements["proxy-status"].textContent, "Подключено");
    assert.equal(app.elements["proxy-status"].title, "Прокси включён в браузере.");
    assert.equal(app.elements["proxy-status"].dataset.tone, "ok");
    assert.equal(JSON.stringify(app.elements).includes(host), false);
    assert.deepEqual(app.reads, [{ incognito: false }]);
    assert.deepEqual(app.requests, []);
  }
});

test("disabled proxy does not contact an external server or claim a direct connection", async () => {
  const app = await setup({ active: false });
  assert.equal(app.elements["proxy-status"].textContent, "Отключено");
  assert.match(app.elements["proxy-status"].title, /настройки браузера или системы/);
  assert.equal(app.elements["proxy-status"].dataset.tone, "off");
  assert.deepEqual(app.requests, []);
  assert.equal(app.reads.length, 1);
});

test("proxy controlled elsewhere is shown separately from this extension's active proxy", async () => {
  for (const control of ["controlled_by_other_extensions", "not_controllable"]) {
    const app = await setup({ control });
    assert.equal(app.elements["proxy-status"].textContent, "Внешнее управление");
    assert.equal(app.elements["proxy-status"].dataset.tone, "warn");
    assert.match(app.elements["proxy-status"].title, /другим расширением/);
    assert.deepEqual(app.requests, []);
  }
});

test("settings without this extension's single proxy are not shown as active", async () => {
  for (const value of [{ mode: "direct" }, { mode: "pac_script" }, { mode: "fixed_servers", rules: {} }]) {
    const app = await setup({ value });
    assert.equal(app.elements["proxy-status"].textContent, "Отключено");
    assert.deepEqual(app.requests, []);
  }
});

test("unknown proxy state is never silently shown as disabled", async () => {
  const app = await setup({ proxyFails: true });
  assert.equal(app.elements["proxy-status"].textContent, "Неизвестно");
  assert.equal(app.elements["proxy-status"].dataset.tone, "error");
  assert.match(app.elements["proxy-status"].title, /Не удалось прочитать/);
  assert.deepEqual(app.requests, []);
});

test("popup follows changes to the browser proxy while open", async () => {
  const app = await setup({ active: false });
  app.effective.levelOfControl = "controlled_by_this_extension";
  app.effective.value = {
    mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "new.example.com", port: 3128 } },
  };
  await app.change();
  assert.equal(app.elements["proxy-status"].dataset.tone, "ok");

  app.effective.levelOfControl = "controlled_by_other_extensions";
  await app.change();
  assert.equal(app.elements["proxy-status"].textContent, "Внешнее управление");
  assert.equal(app.elements["proxy-status"].dataset.tone, "warn");

  app.effective.levelOfControl = "controllable_by_this_extension";
  app.effective.value = { mode: "system" };
  await app.change();
  assert.equal(app.elements["proxy-status"].textContent, "Отключено");
  assert.equal(app.elements["proxy-status"].dataset.tone, "off");
  assert.deepEqual(app.requests, []);
});

test("a failed status update clears the active state and the next update can recover", async () => {
  const app = await setup({ readProxy(effective, read) {
    if (read === 2) throw new Error("Proxy API failed");
    return effective;
  } });
  await app.change();
  assert.equal(app.elements["proxy-status"].textContent, "Неизвестно");
  assert.equal(app.elements["proxy-status"].dataset.tone, "error");
  assert.doesNotMatch(app.elements["proxy-status"].title, /proxy\.example\.com/);

  await app.change();
  assert.equal(app.elements["proxy-status"].dataset.tone, "ok");
  assert.deepEqual(app.requests, []);
});

test("a delayed initial read or error cannot overwrite newer proxy settings", async () => {
  for (const fail of [false, true]) {
    let finish, reject;
    const pending = new Promise((resolve, failRead) => { finish = resolve; reject = failRead; });
    const app = await setup({ readProxy: (effective, read) => read === 1 ? pending : effective });
    const before = clone(app.effective);
    app.effective.levelOfControl = "controllable_by_this_extension";
    app.effective.value = { mode: "system" };
    await app.change();
    if (fail) reject(new Error("Old read failed"));
    else finish(before);
    await tick();
    assert.equal(app.elements["proxy-status"].textContent, "Отключено");
    assert.equal(app.elements["proxy-status"].dataset.tone, "off");
    assert.deepEqual(app.requests, []);
  }
});

test("popup keeps feature switches in settings and exposes accessible controls", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const popup = readFileSync("popup/index.html", "utf8");
  const html = readFileSync(manifest.options_ui.page, "utf8");
  assert.equal(manifest.options_ui.page, "settings/index.html");
  assert.ok(popup.includes('href="../settings/index.html"'));
  assert.doesNotMatch(popup, /data-setting|data-state/);
  assert.equal([...popup.matchAll(/<a\b/g)].length, 1);
  assert.match(popup, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(popup, /<span class="proxy-label">Статус прокси<\/span>/);
  assert.match(popup, /<header\b[^>]*>[\s\S]*class="button settings-button"[^>]*aria-label="Открыть настройки"[\s\S]*<\/header>/);
  assert.match(popup, /id="proxy-status" class="status-label"/);
  assert.doesNotMatch(popup, /proxy-address|copy-proxy|proxy-meta|feature-count|feature-summary/);
  assert.doesNotMatch(popup, /connection-title|class="led"/);
  for (const key of ["youtubeTheaterEnabled", "youtubeFullChatEnabled", "pageVisibilityEnabled"]) {
    assert.ok(html.includes(`data-setting="${key}"`));
  }
  assert.match(html, /id="proxy-form"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "page IDs must be unique");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) =>
    readFileSync(path.join(path.dirname(manifest.options_ui.page), match[1]), "utf8"));
  assert.equal(scripts.length, 2);
  assert.doesNotThrow(() => new vm.Script(scripts.join("\n")), "independent scripts must not collide in global scope");
});
