const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const vm = require("node:vm");

const base = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const secret = "a".repeat(64);
const popup = { url: `${base}popup/index.html` };
const owner = { tab: { id: 4 }, frameId: 5 };

function backgroundSetup({ videos, tabUrl = "https://site.example/watch" } = {}) {
  let listener;
  const saved = {};
  const calls = { injection: [], messages: [], requests: [] };
  const selected = { id: "1", origin: "https://site.example", paused: false, area: 100, visible: true };
  const chrome = {
    runtime: { getURL: (path) => base + path, onMessage: { addListener(value) { listener = value; } } },
    storage: { session: {
      async get(key) { return { [key]: structuredClone(saved[key]) }; },
      async set(values) { Object.assign(saved, structuredClone(values)); },
      async remove(key) { delete saved[key]; },
    } },
    scripting: { async executeScript(value) {
      calls.injection.push(value);
      return [{ frameId: 5, result: { videos: videos || [selected] } }];
    } },
    tabs: {
      async get(tabId) { return { id: tabId, url: tabUrl }; },
      async sendMessage(tabId, message, options) {
        calls.messages.push({ tabId, message, options });
        if (message.action === "start") return { started: true };
        if (message.action === "probe") return { active: true };
        return { ok: true };
      },
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
    },
  };
  vm.runInNewContext(readFileSync("features/video-upscale/inpage-background.js", "utf8"), {
    chrome, crypto: { randomUUID }, console,
    async fetch(url) { calls.requests.push(url); throw new Error("Unexpected network request"); },
  });
  const send = (message, sender = popup) => new Promise((resolve) => {
    const pending = listener(message, sender, resolve);
    if (!pending) resolve(undefined);
  });
  return { send, saved, calls };
}

test("WebGPU starts and stops on the selected frame without network requests", async () => {
  const app = backgroundSetup();
  const initial = await app.send({ type: "video-upscale:get-state", tabId: 4 });
  assert.equal(initial.enabled, false);
  assert.equal(initial.model, "webgpu-fast");
  assert.deepEqual(Array.from(initial.models, (model) => model.id), ["webgpu-fast", "webgpu-quality"]);
  const result = await app.send({ type: "video-upscale:start", tabId: 4, model: "webgpu-quality" });
  assert.equal(result.enabled, true);
  assert.equal(result.model, "webgpu-quality");
  const start = app.calls.messages.find((item) => item.message.action === "start");
  assert.equal(start.message.model, "webgpu-quality");
  assert.equal(start.options.frameId, 5);
  assert.equal(app.calls.injection[0].target.allFrames, true);
  const stopped = await app.send({ type: "video-upscale:stop", tabId: 4 });
  assert.equal(stopped.enabled, false);
  assert.ok(app.calls.messages.some((item) => item.message.action === "stop"));
  assert.deepEqual(app.calls.requests, []);
});

test("WebGPU status is accepted only from its active session and owning frame", async () => {
  const app = backgroundSetup();
  await app.send({ type: "video-upscale:start", tabId: 4, model: "webgpu-fast" });
  const id = app.saved["videoUpscaleTab:4"].id;
  const update = { type: "video-upscale:content-status", id, phase: "playing", message: "GPU", metrics: { displayedFps: 25, latencyMs: 8, secret, sourceFps: 25 },
    diagnostics: { adapter: { vendor: "nvidia" }, secret } };
  await app.send(update, { tab: { id: 4 }, frameId: 6 });
  assert.equal(app.saved["videoUpscaleTab:4"].phase, "starting");
  await app.send({ ...update, id: randomUUID() }, owner);
  assert.equal(app.saved["videoUpscaleTab:4"].phase, "starting");
  await app.send(update, owner);
  const state = await app.send({ type: "video-upscale:get-state", tabId: 4 });
  assert.equal(state.message, "GPU · 25 из 25 кадр/с · кадр 8 мс");
  assert.doesNotMatch(JSON.stringify(app.saved), new RegExp(`${secret}|nvidia|diagnostics|metrics`));
});

test("unknown models fail before injection", async () => {
  const app = backgroundSetup();
  for (const model of ["superultracompact", "webgpu-nomos-medium", "webgpu-nomos-multijpg", "realesrgan-x2plus-fp16", "unknown"]) {
    assert.ok((await app.send({ type: "video-upscale:start", tabId: 4, model })).error);
  }
  assert.equal(app.calls.injection.length, 0);
});

test("start, stop and state commands are accepted only from the popup", async () => {
  const app = backgroundSetup();
  for (const type of ["start", "stop", "get-state"]) {
    const rejected = await app.send({ type: `video-upscale:${type}`, tabId: 42 }, { tab: { id: 42 }, frameId: 0, url: "https://site.example" });
    assert.match(rejected.error, /попапа/);
  }
  assert.equal(app.calls.injection.length, 0);
  assert.equal(app.saved["videoUpscaleTab:42"], undefined);
});

test("protected media fails before attaching the canvas", async () => {
  const app = backgroundSetup({ videos: [{ id: "1", visible: true, area: 100, error: "DRM не поддерживается" }] });
  assert.match((await app.send({ type: "video-upscale:start", tabId: 42 })).error, /DRM/);
  assert.equal(app.calls.messages.length, 0);
});

test("file and browser-internal tabs are rejected before scripting access", async () => {
  for (const tabUrl of ["file:///C:/Users/video.mp4", "chrome://extensions/", `${base}popup/index.html`]) {
    const app = backgroundSetup({ tabUrl });
    const result = await app.send({ type: "video-upscale:start", tabId: 42 });
    assert.match(result.error, /HTTP\(S\)/);
    assert.equal(app.calls.injection.length, 0);
  }
});

test("concurrent popup starts create only one session and reopening reads its state", async () => {
  const app = backgroundSetup();
  const command = { type: "video-upscale:start", tabId: 42 };
  const states = await Promise.all([app.send(command), app.send(command)]);
  assert.ok(states.every((state) => state.enabled));
  assert.equal(app.calls.injection.length, 1);
  assert.equal((await app.send({ type: "video-upscale:get-state", tabId: 42 })).enabled, true);
});

test("stale frame messages cannot stop a replacement session or another tab", async () => {
  const app = backgroundSetup();
  await app.send({ type: "video-upscale:start", tabId: 42 });
  const old = app.saved["videoUpscaleTab:42"];
  await app.send({ type: "video-upscale:start", tabId: 43 });
  const otherId = app.saved["videoUpscaleTab:43"].id;
  await app.send({ type: "video-upscale:stop", tabId: 42 });
  assert.equal(app.saved["videoUpscaleTab:43"].enabled, true);
  await app.send({ type: "video-upscale:start", tabId: 42 });
  const replacementId = app.saved["videoUpscaleTab:42"].id;
  assert.notEqual(replacementId, old.id);
  await app.send({ type: "video-upscale:content-closed", id: old.id }, { tab: { id: 42 }, frameId: 5, url: "https://site.example" });
  assert.equal(app.saved["videoUpscaleTab:42"].id, replacementId);
  assert.equal(app.saved["videoUpscaleTab:42"].enabled, true);
  assert.equal(app.saved["videoUpscaleTab:43"].id, otherId);
});

test("manifest exposes only the WebGPU runtime and needs no native messaging", () => {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
  assert.match(manifest.content_security_policy.extension_pages, /'wasm-unsafe-eval'/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /'unsafe-eval'|https?:/);
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ["features/video-upscale/webgpu-client.mjs",
      "features/video-upscale/wasm/pkg/*.js", "features/video-upscale/wasm/pkg/*.wasm",
      "features/video-upscale/webgpu-models/catalogue.json", "features/video-upscale/webgpu-models/*.bin"],
    matches: ["http://*/*", "https://*/*"],
  }]);
});
