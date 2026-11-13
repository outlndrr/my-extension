const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const source = readFileSync("popup/popup.js", "utf8");
const tick = () => new Promise(setImmediate);
const clone = (value) => JSON.parse(JSON.stringify(value));

async function setup({ active = true, control, value, proxyFails = false, readProxy,
  storage = {}, storageFails = false, readFeatures, clipboardWrite = async () => {} } = {}) {
  const elements = Object.fromEntries(["proxy-status", "proxy-server", "proxy-address", "proxy-meta",
    "proxy-detail", "copy-proxy", "copy-status", "feature-count"].map((id) => [id, {
    textContent: "", title: "", dataset: {}, hidden: ["proxy-server", "proxy-detail"].includes(id),
    disabled: id === "copy-proxy", listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
  }]));
  const effective = {
    levelOfControl: control || (active ? "controlled_by_this_extension" : "controllable_by_this_extension"),
    value: value || (active
      ? { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "proxy.example.com", port: 8080 } } }
      : { mode: "system" }),
  };
  const requests = [];
  const reads = [];
  const storageReads = [];
  const copies = [];
  const changeListeners = [];
  const storageListeners = [];
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id] },
    fetch: async (url) => { requests.push(url); throw new Error("Unexpected network request"); },
    navigator: { clipboard: { async writeText(address) {
      copies.push(address);
      return clipboardWrite(address);
    } } },
    // No runtime API: the popup must not request saved proxy credentials from the worker.
    chrome: {
      proxy: { settings: {
        onChange: { addListener(listener) { changeListeners.push(listener); } },
        async get(options) {
          reads.push(clone(options));
          if (proxyFails) throw new Error("Proxy API failed");
          return readProxy ? readProxy(clone(effective), reads.length) : clone(effective);
        },
      } },
      storage: {
        onChanged: { addListener(listener) { storageListeners.push(listener); } },
        local: { async get(defaults) {
          storageReads.push(clone(defaults));
          if (storageFails) throw new Error("Storage failed");
          const saved = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
            [key, Object.hasOwn(storage, key) ? storage[key] : fallback]));
          return readFeatures ? readFeatures(clone(saved), storageReads.length) : clone(saved);
        } },
      },
    },
  });
  await tick();
  return {
    elements, effective, requests, reads, storage, storageReads, copies,
    async change() {
      for (const listener of changeListeners) listener(clone(effective));
      await tick();
    },
    async storageChange(changes, area = "local") {
      if (area === "local") {
        for (const [key, change] of Object.entries(changes)) {
          if (Object.hasOwn(change, "newValue")) storage[key] = change.newValue;
          else delete storage[key];
        }
      }
      for (const listener of storageListeners) listener(clone(changes), area);
      await tick();
    },
    copy: () => elements["copy-proxy"].listeners.click(),
  };
}

test("popup shows the browser's active proxy without network requests or reading credentials", async () => {
  const app = await setup();
  assert.equal(app.elements["proxy-status"].textContent, "Подключено");
  assert.equal(app.elements["proxy-status"].title, "Прокси включён в браузере.");
  assert.equal(app.elements["proxy-address"].textContent, "proxy.example.com:8080");
  assert.equal(app.elements["proxy-address"].title, "");
  assert.equal(app.elements["proxy-meta"].textContent, "HTTP");
  assert.equal(app.elements["proxy-server"].hidden, false);
  assert.equal(app.elements["proxy-detail"].hidden, true);
  assert.equal(app.elements["copy-proxy"].disabled, false);
  assert.equal(app.elements["proxy-status"].dataset.tone, "ok");
  assert.deepEqual(app.reads, [{ incognito: false }]);
  assert.deepEqual(app.requests, []);
});

test("popup formats IPv6 addresses without revealing them in tooltips", async () => {
  for (const host of ["2001:db8::1", "[2001:db8::1]"]) {
    const app = await setup({ value: {
      mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host, port: 1080 } },
    } });
    assert.equal(app.elements["proxy-status"].title, "Прокси включён в браузере.");
    assert.equal(app.elements["proxy-address"].textContent, "[2001:db8::1]:1080");
    assert.equal(app.elements["proxy-address"].title, "");
    assert.equal(app.elements["proxy-meta"].textContent, "SOCKS5");
    assert.equal(app.elements["proxy-status"].dataset.tone, "ok");
    assert.deepEqual(app.requests, []);
  }
});

test("disabled proxy does not contact an external server or claim a direct connection", async () => {
  const app = await setup({ active: false });
  assert.equal(app.elements["proxy-status"].textContent, "Отключено");
  assert.match(app.elements["proxy-status"].title, /настройки браузера или системы/);
  assert.equal(app.elements["proxy-status"].dataset.tone, "off");
  assert.equal(app.elements["proxy-server"].hidden, true);
  assert.equal(app.elements["copy-proxy"].disabled, true);
  assert.equal(app.elements["proxy-detail"].hidden, false);
  assert.match(app.elements["proxy-detail"].textContent, /настройки браузера или системы/);
  assert.deepEqual(app.requests, []);
  assert.equal(app.reads.length, 1);
});

test("proxy controlled elsewhere is shown separately from this extension's active proxy", async () => {
  for (const control of ["controlled_by_other_extensions", "not_controllable"]) {
    const app = await setup({ control });
    assert.equal(app.elements["proxy-status"].textContent, "Внешнее управление");
    assert.equal(app.elements["proxy-status"].dataset.tone, "warn");
    assert.equal(app.elements["proxy-detail"].hidden, false);
    assert.match(app.elements["proxy-detail"].textContent, /другим расширением/);
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
  assert.equal(app.elements["proxy-detail"].hidden, false);
  assert.match(app.elements["proxy-detail"].textContent, /Не удалось прочитать/);
  assert.equal(app.elements["feature-count"].textContent, "3 из 3");
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
  assert.equal(app.elements["proxy-address"].textContent, "new.example.com:3128");

  app.effective.value.rules.singleProxy.host = "other.example.com";
  await app.change();
  assert.equal(app.elements["proxy-address"].title, "");
  assert.equal(app.elements["proxy-address"].textContent, "other.example.com:3128");

  app.effective.levelOfControl = "controlled_by_other_extensions";
  await app.change();
  assert.equal(app.elements["proxy-status"].textContent, "Внешнее управление");
  assert.equal(app.elements["proxy-status"].dataset.tone, "warn");

  app.effective.levelOfControl = "controllable_by_this_extension";
  app.effective.value = { mode: "system" };
  await app.change();
  assert.equal(app.elements["proxy-status"].textContent, "Отключено");
  assert.equal(app.elements["proxy-status"].dataset.tone, "off");
  assert.equal(app.elements["proxy-server"].hidden, true);
  assert.equal(app.elements["proxy-address"].textContent, "");
  assert.equal(app.elements["copy-proxy"].disabled, true);
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
  assert.equal(app.elements["proxy-server"].hidden, true);
  assert.equal(app.elements["proxy-address"].textContent, "");

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

test("copy button writes only the visible server address and reports success", async () => {
  const app = await setup();
  await app.copy();
  assert.deepEqual(app.copies, ["proxy.example.com:8080"]);
  assert.equal(app.elements["copy-status"].textContent, "Адрес скопирован");
  assert.equal(app.elements["copy-status"].dataset.tone, "ok");
  assert.equal(app.elements["copy-proxy"].disabled, false);

  const disabled = await setup({ active: false });
  await disabled.copy();
  assert.deepEqual(disabled.copies, []);
});

test("clipboard failure is explained and copying can be retried", async () => {
  let fail = true;
  const app = await setup({ clipboardWrite: async () => { if (fail) throw new Error("Clipboard denied"); } });
  await app.copy();
  assert.match(app.elements["copy-status"].textContent, /Выделите адрес/);
  assert.equal(app.elements["copy-status"].dataset.tone, "error");
  assert.equal(app.elements["copy-proxy"].disabled, false);
  assert.equal(app.elements["proxy-status"].dataset.tone, "ok");
  fail = false;
  await app.copy();
  assert.equal(app.elements["copy-status"].textContent, "Адрес скопирован");
});

test("a pending copy cannot leave stale feedback after proxy settings change", async () => {
  for (const disable of [false, true]) {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const app = await setup({ clipboardWrite: () => pending });
    const copying = app.copy();
    assert.equal(app.elements["copy-proxy"].disabled, true);
    if (disable) {
      app.effective.levelOfControl = "controllable_by_this_extension";
      app.effective.value = { mode: "system" };
    } else {
      app.effective.value.rules.singleProxy.host = "new.example.com";
    }
    await app.change();
    finish();
    await copying;
    assert.equal(app.elements["copy-status"].textContent, "");
    assert.equal(app.elements["copy-proxy"].disabled, disable);
    assert.equal(app.elements["proxy-address"].textContent, disable ? "" : "new.example.com:8080");
  }
});

test("feature summary counts the three switches with their defaults and never reads proxy credentials", async () => {
  const defaults = { youtubeTheaterEnabled: true, youtubeFullChatEnabled: true, pageVisibilityEnabled: true };
  for (const [saved, expected] of [
    [{}, "3 из 3"],
    [{ youtubeFullChatEnabled: false, pageVisibilityEnabled: false }, "1 из 3"],
    [{ youtubeTheaterEnabled: false, youtubeFullChatEnabled: false, pageVisibilityEnabled: false }, "0 из 3"],
  ]) {
    const app = await setup({ active: false, storage: {
      ...saved, unrelated: true, browserProxy: { username: "user", password: "secret" },
    } });
    assert.equal(app.elements["feature-count"].textContent, expected);
    assert.deepEqual(app.storageReads, [defaults]);
    assert.deepEqual(app.requests, []);
  }
});

test("feature summary follows local switch changes and removals, ignoring unrelated settings", async () => {
  const app = await setup({ storage: { youtubeTheaterEnabled: false } });
  assert.equal(app.elements["feature-count"].textContent, "2 из 3");
  await app.storageChange({ browserProxy: { newValue: {} } });
  await app.storageChange({ youtubeFullChatEnabled: { newValue: false } }, "sync");
  assert.equal(app.storageReads.length, 1);

  await app.storageChange({ youtubeFullChatEnabled: { newValue: false } });
  assert.equal(app.elements["feature-count"].textContent, "1 из 3");
  assert.equal(app.elements["feature-count"].title, "Disable Page Visibility");

  await app.storageChange({ youtubeTheaterEnabled: { oldValue: false } });
  assert.equal(app.elements["feature-count"].textContent, "2 из 3");
  assert.equal(app.elements["proxy-status"].textContent, "Подключено");
  assert.equal(app.reads.length, 1);
});

test("unreadable feature preferences do not hide the proxy and can recover on an update", async () => {
  let fail = true;
  const app = await setup({ readFeatures(settings) {
    if (fail) throw new Error("Storage failed");
    return settings;
  } });
  assert.equal(app.elements["feature-count"].textContent, "Недоступно");
  assert.equal(app.elements["feature-count"].dataset.tone, "error");
  assert.equal(app.elements["proxy-address"].textContent, "proxy.example.com:8080");

  fail = false;
  await app.storageChange({ pageVisibilityEnabled: { newValue: false } });
  assert.equal(app.elements["feature-count"].textContent, "2 из 3");
  assert.equal(app.elements["feature-count"].dataset.tone, "ok");
});

test("a delayed feature read or error cannot overwrite a newer count", async () => {
  for (const fail of [false, true]) {
    let finish, reject;
    const pending = new Promise((resolve, failRead) => { finish = resolve; reject = failRead; });
    const app = await setup({ readFeatures: (settings, read) => read === 1 ? pending : settings });
    await app.storageChange({ youtubeTheaterEnabled: { newValue: false } });
    if (fail) reject(new Error("Old read failed"));
    else finish({ youtubeTheaterEnabled: true, youtubeFullChatEnabled: true, pageVisibilityEnabled: true });
    await tick();
    assert.equal(app.elements["feature-count"].textContent, "2 из 3");
    assert.equal(app.elements["feature-count"].dataset.tone, "ok");
  }
});

test("popup keeps feature switches in settings and exposes a summary with accessible controls", () => {
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
  assert.match(popup, /id="feature-count"/);
  assert.match(popup, /id="copy-proxy"[^>]*aria-label="Скопировать адрес прокси"/);
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
