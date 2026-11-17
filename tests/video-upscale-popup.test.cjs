const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync("popup/video-upscale.js", "utf8");
const tick = () => new Promise(setImmediate);
const clone = (value) => JSON.parse(JSON.stringify(value));

async function setup({ webgpuModel, initialState = {}, send } = {}) {
  const elements = Object.fromEntries(["upscale-enabled", "upscale-model", "upscale-state"].map((id) => [id, {
    value: "", checked: false, disabled: true, dataset: {}, textContent: "", listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
  }]));
  elements["upscale-model"].options = ["webgpu-fast", "webgpu-quality"].map((value) => ({ value, disabled: false }));
  let state = { enabled: false, phase: "idle", ...initialState };
  const local = webgpuModel ? { videoUpscaleWebGpuModel: webgpuModel } : {};
  const requests = [];
  const windowListeners = {};
  let poll;
  let timerCleared = false;
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id] },
    window: { addEventListener(type, callback) { windowListeners[type] = callback; } },
    setInterval(callback) { poll = callback; return 1; },
    clearInterval() { timerCleared = true; },
    chrome: {
      tabs: { async query() { return [{ id: 42 }]; } },
      storage: { local: {
        async get(defaults) { return { ...defaults, ...local }; },
        async set(values) { Object.assign(local, clone(values)); },
      } },
      runtime: { async sendMessage(message) {
        requests.push(clone(message));
        if (send) return send(clone(message), requests.length);
        if (message.type.endsWith(":start")) state = { enabled: true, phase: "starting", model: message.model };
        if (message.type.endsWith(":stop")) state = { enabled: false, phase: "idle" };
        return clone(state);
      } },
    },
  });
  await tick();
  return {
    elements, local, requests,
    async change(id, value) {
      elements[id][id === "upscale-enabled" ? "checked" : "value"] = value;
      await elements[id].listeners.change();
      await tick();
    },
    poll: () => poll(),
    close() { windowListeners.pagehide(); return timerCleared; },
  };
}

test("popup marks the upscaler as an experimental WebGPU panel with only the two WebSR models", () => {
  const popup = readFileSync("popup/index.html", "utf8");
  assert.match(popup, /<section class="panel upscale"[\s\S]*Эксперимент/);
  assert.doesNotMatch(popup, /upscale-backend|TensorRT|launcher\.js|id="video-upscale"|Nomos|diagnostic|upscale-model-hint/);
  const options = [...popup.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, ["webgpu-fast", "webgpu-quality"]);
});

test("WebGPU Fast is the default and starts with only the tab and model", async () => {
  const app = await setup();
  assert.equal(app.elements["upscale-model"].value, "webgpu-fast");
  await app.change("upscale-enabled", true);
  assert.deepEqual(app.requests.at(-1), { type: "video-upscale:start", tabId: 42, model: "webgpu-fast" });
  assert.equal(app.elements["upscale-enabled"].checked, true);
  assert.equal(app.elements["upscale-model"].disabled, true);
});

test("upscale popup saves and starts the chosen model", async () => {
  const app = await setup();
  await app.change("upscale-model", "webgpu-quality");
  assert.deepEqual(app.local, { videoUpscaleWebGpuModel: "webgpu-quality" });
  await app.change("upscale-enabled", true);
  assert.deepEqual(app.requests.at(-1), { type: "video-upscale:start", tabId: 42, model: "webgpu-quality" });
});

test("upscale popup restores a running tab and stops it", async () => {
  const app = await setup({ initialState: { enabled: true, phase: "playing", model: "webgpu-quality" } });
  assert.equal(app.elements["upscale-enabled"].checked, true);
  assert.equal(app.elements["upscale-model"].value, "webgpu-quality");
  await app.change("upscale-enabled", false);
  assert.deepEqual(app.requests.at(-1), { type: "video-upscale:stop", tabId: 42 });
  assert.equal(app.elements["upscale-enabled"].checked, false);
  assert.equal(app.elements["upscale-model"].disabled, false);
});

test("an unknown or removed saved model falls back to WebGPU Fast", async () => {
  for (const webgpuModel of ["superultracompact", "webgpu-nomos-medium", "webgpu-nomos-multijpg"]) {
    const app = await setup({ webgpuModel });
    assert.equal(app.elements["upscale-model"].value, "webgpu-fast");
  }
});

test("late idle response cannot overwrite a newly started session", async () => {
  let resolvePoll;
  const app = await setup({ send(message, count) {
    if (count === 2) return new Promise((resolve) => { resolvePoll = resolve; });
    return { enabled: message.type.endsWith(":start"), model: "webgpu-fast" };
  } });
  const pending = app.poll();
  await app.change("upscale-enabled", true);
  resolvePoll({ enabled: false });
  await pending;
  assert.equal(app.elements["upscale-enabled"].checked, true);
});

test("closing the popup stops polling but leaves video processing running", async () => {
  const app = await setup({ initialState: { enabled: true, phase: "playing" } });
  assert.equal(app.close(), true);
  await app.poll();
  assert.deepEqual(app.requests.map((request) => request.type), ["video-upscale:get-state"]);
});

test("model availability and background errors are presented without claiming success", async () => {
  const app = await setup({ send(message) {
    if (message.type.endsWith(":start")) return { error: "Нет подходящего видео на странице." };
    return { enabled: false, models: [{ id: "webgpu-quality", available: false }] };
  } });
  assert.equal(app.elements["upscale-model"].options[1].disabled, true);
  await app.change("upscale-enabled", true);
  assert.equal(app.elements["upscale-enabled"].checked, false);
  assert.equal(app.elements["upscale-state"].textContent, "Нет подходящего видео на странице.");
});
