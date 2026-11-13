const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync("features/proxy/background.js", "utf8");
const clean = (value) => JSON.parse(JSON.stringify(value));
const settings = { scheme: "http", host: "proxy.example.com", port: 8080, username: "user", password: "secret" };
const event = () => ({ addListener(listener, filter, options) { Object.assign(this, { listener, filter, options }); } });

function setup({ control = "controllable_by_this_extension", setFails = false, writeFails = false } = {}) {
  const local = {};
  const session = {};
  const calls = [];
  const effective = { levelOfControl: control, value: { mode: "system" } };
  function area(data) {
    return {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: data[keys] };
        return { ...keys, ...data };
      },
      async set(values) {
        if (data === local && writeFails) throw new Error("Storage failed");
        Object.assign(data, clean(values));
      },
      async remove(key) { delete data[key]; },
    };
  }
  const chrome = {
    runtime: { id: "test", getURL: (path) => `chrome-extension://test/${path}`, onMessage: event() },
    storage: { local: area(local), session: area(session) },
    proxy: { settings: {
      async get() { return clean(effective); },
      async set(value) {
        if (setFails) throw new Error("Proxy failed");
        calls.push(clean(value));
        effective.value = clean(value.value);
        effective.levelOfControl = "controlled_by_this_extension";
      },
      async clear(value) {
        calls.push({ clear: value.scope });
        effective.value = { mode: "system" };
        effective.levelOfControl = "controllable_by_this_extension";
      },
    } },
    webRequest: { onAuthRequired: event(), onCompleted: event(), onErrorOccurred: event() },
  };
  const context = vm.createContext({ chrome, URL });
  vm.runInContext(source, context);
  const sender = { id: "test", url: chrome.runtime.getURL("settings/index.html") };
  function send(type, config = settings) {
    return new Promise((resolve) => chrome.runtime.onMessage.listener({ type, settings: config }, sender, resolve));
  }
  async function auth(overrides = {}) {
    return clean(await new Promise((resolve) => chrome.webRequest.onAuthRequired.listener({
      isProxy: true, requestId: "1", challenger: { host: settings.host, port: settings.port }, ...overrides,
    }, resolve)));
  }
  return { chrome, context, local, session, effective, calls, send, auth };
}

test("validates and normalizes HTTP/SOCKS5, including IDN and IPv6", () => {
  const { context } = setup();
  const normalize = (input) => clean(context.normalizeSettings(input));
  assert.deepEqual(normalize({ ...settings, host: " PROXY.example.com ", port: "1080" }), {
    ...settings, host: "proxy.example.com", port: 1080,
  });
  assert.equal(normalize({ ...settings, host: "пример.рф" }).host, "xn--e1afmkfd.xn--p1ai");
  assert.equal(normalize({ ...settings, host: "[::1]" }).host, "[::1]");
  assert.equal(normalize({ ...settings, scheme: "socks5", username: "", password: "" }).scheme, "socks5");
  assert.equal(normalize({ ...settings, password: "" }).username, "user");
  for (const patch of [
    { scheme: "https" }, { host: "" }, { host: "https://proxy.example.com" },
    { host: "user@proxy.example.com" }, { host: "example.com:80" }, { host: "example.com/path" },
    { host: "example.com?query" }, { host: "example.com\\path" }, { host: "[::1]:80" },
    { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: "" }, { port: true }, { port: "0x50" },
    { username: "", password: "secret" }, { scheme: "socks5" }, { password: null },
  ]) assert.throws(() => normalize({ ...settings, ...patch }), JSON.stringify(patch));
});

test("applies one proxy to the profile and clears its override without forcing direct mode", async () => {
  const app = setup();
  const result = await app.send("proxy:apply");
  assert.equal(result.ok, true);
  assert.equal(result.control, "controlled_by_this_extension");
  assert.deepEqual(app.calls, [{ scope: "regular", value: {
    mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: settings.host, port: 8080 } },
  } }]);
  assert.deepEqual(app.local.browserProxy, settings);
  assert.equal((await app.send("proxy:disable")).ok, true);
  assert.deepEqual(app.calls[1], { clear: "regular" });
  assert.deepEqual(await app.auth(), {});
  assert.equal(app.local.browserProxy.password, "secret", "disable preserves saved form");
});

test("SOCKS5 without authentication and HTTP without credentials both work", async () => {
  for (const scheme of ["http", "socks5"]) {
    const app = setup();
    assert.equal((await app.send("proxy:apply", { ...settings, scheme, username: "", password: "" })).ok, true);
    assert.deepEqual(await app.auth(), {});
    assert.equal(app.effective.value.rules.singleProxy.scheme, scheme);
  }
});

test("rejects invalid settings and conflicts before saving; failed commands do not poison the queue", async () => {
  const app = setup();
  assert.equal((await app.send("proxy:apply", { ...settings, port: -1 })).ok, false);
  assert.deepEqual(app.local, {});
  assert.equal((await app.send("proxy:apply")).ok, true);
  for (const control of ["not_controllable", "controlled_by_other_extensions"]) {
    const blocked = setup({ control });
    assert.equal((await blocked.send("proxy:apply")).ok, false);
    assert.deepEqual(blocked.local, {});
    assert.deepEqual(blocked.calls, []);
  }
});

test("storage and proxy API failures do not replace existing credentials", async () => {
  const app = setup({ setFails: true });
  app.local.browserProxy = { ...settings, password: "old" };
  assert.equal((await app.send("proxy:apply")).ok, false);
  assert.equal(app.local.browserProxy.password, "old");
  const broken = setup({ writeFails: true });
  assert.equal((await broken.send("proxy:apply")).ok, false);
  assert.deepEqual(broken.calls, []);
});

test("credentials only answer this extension's matching HTTP proxy, never a website or another proxy", async () => {
  const app = setup();
  await app.send("proxy:apply");
  assert.deepEqual(await app.auth({ isProxy: false }), {});
  assert.deepEqual(await app.auth({ challenger: { host: "evil.example", port: 8080 } }), {});
  assert.deepEqual(await app.auth({ challenger: { host: settings.host, port: 9999 } }), {});
  app.effective.value.rules.singleProxy.host = "different.example";
  assert.deepEqual(await app.auth(), {});
  app.effective.value.rules.singleProxy.host = settings.host;
  app.effective.levelOfControl = "controlled_by_other_extensions";
  assert.deepEqual(await app.auth(), {});
  app.effective.levelOfControl = "controlled_by_this_extension";
  assert.deepEqual(await app.auth(), { authCredentials: { username: "user", password: "secret" } });
  assert.deepEqual(await app.auth(), { cancel: true }, "wrong password must not loop");
  // Reloading the worker retains the session retry marker.
  vm.runInContext(`(function () { ${source}\n })()`, app.context);
  assert.deepEqual(await app.auth(), { cancel: true });
  app.chrome.webRequest.onCompleted.listener({ requestId: "1" });
  assert.deepEqual(app.session, {});
  assert.deepEqual(await app.auth({ requestId: "2" }), { authCredentials: { username: "user", password: "secret" } });
  app.chrome.webRequest.onErrorOccurred.listener({ requestId: "2" });
  assert.deepEqual(app.session, {});
});

test("content scripts and unrelated extension pages cannot change proxy settings or request stored passwords", () => {
  const app = setup();
  for (const sender of [
    { id: "test", url: "https://www.youtube.com/watch?v=test" },
    { id: "other", url: "chrome-extension://test/settings/index.html" },
    { id: "test", url: "chrome-extension://test/popup/index.html" },
  ]) {
    let responded = false;
    assert.equal(app.chrome.runtime.onMessage.listener({ type: "proxy:get" }, sender, () => { responded = true; }), false);
    assert.equal(responded, false);
  }
  assert.deepEqual(app.calls, []);
});

test("manifest wires the service worker, settings page and MV3 auth permissions", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  for (const permission of ["proxy", "storage", "webRequest", "webRequestAuthProvider"]) {
    assert.ok(manifest.permissions.includes(permission));
  }
  assert.ok(!manifest.permissions.includes("webRequestBlocking"));
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  for (const path of [manifest.background.service_worker, manifest.options_ui.page]) {
    assert.doesNotThrow(() => readFileSync(path));
  }
});
