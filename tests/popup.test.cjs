const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const source = readFileSync("popup/popup.js", "utf8");
const tick = () => new Promise(setImmediate);
const clone = (value) => JSON.parse(JSON.stringify(value));

async function setup({ active = true, control, value, proxyFails = false,
  afterFails = false, probe = async () => ({ ok: true }) } = {}) {
  const elements = Object.fromEntries(["proxy-status", "proxy-detail"].map((id) => [id, {
    textContent: "", dataset: {},
  }]));
  const effective = {
    levelOfControl: control || (active ? "controlled_by_this_extension" : "controllable_by_this_extension"),
    value: value || (active
      ? { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "proxy.example.com", port: 8080 } } }
      : { mode: "system" }),
  };
  const requests = [];
  const reads = [];
  const timeouts = [];
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id] },
    AbortSignal: { timeout(ms) { timeouts.push(ms); return "timeout-signal"; } },
    fetch: async (url, options) => { requests.push({ url, options: clone(options) }); return probe(); },
    // No storage or runtime API: the popup must not read preferences or credentials.
    chrome: { proxy: { settings: { async get(options) {
      reads.push(clone(options));
      if (proxyFails || (afterFails && reads.length > 1)) throw new Error("Proxy API failed");
      return clone(effective);
    } } } },
  });
  await tick();
  return { elements, effective, requests, reads, timeouts };
}

test("popup checks only the active proxy without reading feature preferences or credentials", async () => {
  const app = await setup();
  assert.equal(app.elements["proxy-status"].textContent, "Соединение работает");
  assert.equal(app.elements["proxy-status"].dataset.tone, "ok");
  assert.deepEqual(app.reads, [{ incognito: false }, { incognito: false }]);
  assert.deepEqual(app.timeouts, [8000]);
  assert.deepEqual(app.requests, [{ url: "https://example.com/", options: {
    method: "HEAD", cache: "no-store", credentials: "omit", redirect: "error",
    referrerPolicy: "no-referrer", signal: "timeout-signal",
  } }]);
});

test("disabled proxy does not contact an external server or claim a direct connection", async () => {
  const app = await setup({ active: false });
  assert.match(app.elements["proxy-status"].textContent, /Отключён/);
  assert.match(app.elements["proxy-detail"].textContent, /настройки браузера или системы/);
  assert.equal(app.elements["proxy-status"].dataset.tone, "off");
  assert.deepEqual(app.requests, []);
  assert.equal(app.reads.length, 1);
});

test("proxy controlled elsewhere is not claimed to have a tested connection", async () => {
  for (const control of ["controlled_by_other_extensions", "not_controllable"]) {
    const app = await setup({ control });
    assert.match(app.elements["proxy-status"].textContent, /вне расширения/);
    assert.equal(app.elements["proxy-status"].dataset.tone, "warn");
    assert.deepEqual(app.requests, []);
  }
});

test("settings without this extension's single proxy do not trigger a probe", async () => {
  for (const value of [{ mode: "direct" }, { mode: "pac_script" }, { mode: "fixed_servers", rules: {} }]) {
    const app = await setup({ value });
    assert.match(app.elements["proxy-status"].textContent, /Отключён/);
    assert.deepEqual(app.requests, []);
  }
});

test("network errors, timeout and non-success responses never claim a working connection", async () => {
  for (const probe of [async () => { throw new Error("Network or timeout"); }, async () => ({ ok: false })]) {
    const app = await setup({ probe });
    assert.match(app.elements["proxy-status"].textContent, /не подтверждено/);
    assert.match(app.elements["proxy-detail"].textContent, /Прокси включён/);
    assert.equal(app.elements["proxy-status"].dataset.tone, "error");
  }
});

test("unknown proxy state is never silently shown as disabled", async () => {
  for (const options of [{ proxyFails: true }, { afterFails: true }]) {
    const app = await setup(options);
    assert.equal(app.elements["proxy-status"].textContent, "Состояние неизвестно");
    assert.equal(app.elements["proxy-status"].dataset.tone, "error");
    if (options.proxyFails) assert.deepEqual(app.requests, []);
  }
});

test("disabling, changing or losing control of the proxy during the probe cannot show stale success", async () => {
  for (const change of ["disable", "server", "control"]) {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const app = await setup({ probe: () => pending });
    assert.match(app.elements["proxy-status"].textContent, /Проверка/);
    assert.equal(app.elements["proxy-status"].dataset.tone, "pending");
    if (change === "disable") {
      app.effective.levelOfControl = "controllable_by_this_extension";
      app.effective.value = { mode: "system" };
    } else if (change === "server") {
      app.effective.value.rules.singleProxy.host = "new.example.com";
    } else {
      app.effective.levelOfControl = "controlled_by_other_extensions";
    }
    finish({ ok: true });
    await tick();
    assert.match(app.elements["proxy-status"].textContent,
      change === "disable" ? /Отключён/ : change === "server" ? /изменились/ : /вне расширения/);
    assert.notEqual(app.elements["proxy-status"].dataset.tone, "ok");
  }
});

test("popup stays minimal while all independent controls remain on the settings page", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  const popup = readFileSync("popup/index.html", "utf8");
  const html = readFileSync(manifest.options_ui.page, "utf8");
  assert.equal(manifest.options_ui.page, "settings/index.html");
  assert.ok(popup.includes('href="../settings/index.html"'));
  assert.doesNotMatch(popup, /data-setting|data-state|feature-count/);
  assert.equal([...popup.matchAll(/<a\b/g)].length, 1);
  assert.match(popup, /role="status" aria-live="polite" aria-atomic="true"/);
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
