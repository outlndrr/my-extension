const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const coreSource = readFileSync("features/video-upscale/live-frame-core.js", "utf8");
const contentSource = readFileSync("features/video-upscale/inpage-content.js", "utf8");
let nextFactory = 0;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 3; index++) await new Promise(setImmediate);
}

function setup(t) {
  const initialization = deferred();
  const created = deferred();
  const frames = [], renders = [], messages = [], elements = [], creations = [];
  const raf = new Map(), callbacks = new Map(), timers = new Map();
  let now = 0, nextTimer = 0, listener, inFlight = 0, maximumInFlight = 0, captureError;
  const gpu = {
    info: { description: "test GPU" }, destroyed: 0, freed: 0,
    render(input) {
      const operation = deferred();
      renders.push({ input, startedAt: now, ...operation });
      maximumInFlight = Math.max(maximumInFlight, ++inFlight);
      return operation.promise.finally(() => { inFlight--; });
    },
    destroy() { this.destroyed++; },
    free() { assert.equal(inFlight, 0, "WASM allocation must outlive the pending render promise"); this.freed++; },
  };
  const factoryKey = Symbol.for(`outlndrr-webgpu-test-${++nextFactory}`);
  globalThis[factoryKey] = (...args) => {
    creations.push(args);
    created.resolve();
    return initialization.promise;
  };
  // Exercise the original dynamic import with Node's standard ESM loader. Only
  // the extension URL resolves to a fake engine; production code is unchanged.
  const moduleUrl = `data:text/javascript,${encodeURIComponent(`export const createWebGpu = (...args) => globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(factoryKey))})](...args);`)}`;
  function events(target) {
    const handlers = new Map();
    return Object.assign(target, {
      addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(handler); },
      removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
      dispatch(type) { for (const handler of [...(handlers.get(type) || [])]) handler(); },
    });
  }
  const parent = { append(element) { element.isConnected = true; element.parentNode = this; } };
  const video = events({
    isConnected: true, videoWidth: 4, videoHeight: 2, readyState: 4,
    currentSrc: "blob:https://site.example/episode", src: "", srcObject: null,
    currentTime: 10, duration: Infinity, volume: 0.7, muted: true, playbackRate: 1,
    paused: false, seeking: false, controls: false, hovered: false,
    style: { cssText: "original video style" }, parentNode: parent,
    getBoundingClientRect() { return { left: 10, top: 20, right: 410, bottom: 220, width: 400, height: 200 }; },
    after(element) { parent.append(element); this.nextSibling = element; },
    matches() { return this.hovered; },
    pause() { throw new Error("Original player must retain playback ownership"); },
    play() { throw new Error("Original player must retain playback ownership"); },
    load() { throw new Error("Original player must retain playback ownership"); },
    requestVideoFrameCallback(callback) { const id = ++nextTimer; callbacks.set(id, callback); return id; },
    cancelVideoFrameCallback(id) { callbacks.delete(id); },
  });
  const document = events({
    body: parent, documentElement: parent, hidden: false, fullscreenElement: null, pictureInPictureElement: null,
    querySelectorAll(selector) { return selector === "video" ? [video] : []; },
    createElement(tag) {
      const element = events({ tag, style: {}, dataset: {}, isConnected: false,
        setAttribute(name, value) { this[name] = value; },
        attachShadow() { return { append(child) { element.child = child; } }; },
        remove() { this.isConnected = false; },
        getContext() { throw new Error("WebGPU path must not read pixels through a 2D canvas"); },
      });
      elements.push(element);
      return element;
    },
  });
  const context = vm.createContext({
    document, window: events({}), origin: "https://site.example", URL, ArrayBuffer,
    innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0,
    performance: { now: () => now },
    getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1", zIndex: "auto", objectFit: "contain", objectPosition: "50% 50%" }; },
    VideoFrame: class {
      constructor(source, options) {
        if (options && captureError) { const error = captureError; captureError = undefined; throw error; }
        this.timestamp = options?.timestamp;
        this.displayWidth = source.videoWidth; this.displayHeight = source.videoHeight;
        this.closed = 0; frames.push(this);
      }
      close() { this.closed++; }
    },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++nextTimer; raf.set(id, callback); return id; },
    cancelAnimationFrame(id) { raf.delete(id); },
    chrome: { runtime: { id: "extension", onMessage: { addListener(value) { listener = value; } },
      getURL(path) { assert.equal(path, "features/video-upscale/webgpu-client.mjs"); return moduleUrl; },
      async sendMessage(message) { messages.push(message); },
    } },
  });
  vm.runInContext(coreSource, context);
  const discovered = vm.runInContext(contentSource, context, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  const send = (message) => new Promise((resolve) => {
    if (!listener({ type: "video-upscale:content", id: "session", ...message }, { id: "extension" }, resolve)) resolve();
  });
  const app = {
    video, document, frames, renders, messages, gpu, creations, raf, callbacks, timers,
    host: () => elements.find((element) => "data-outlndrr-upscale" in element),
    maximumInFlight: () => maximumInFlight,
    failCaptureOnce(error) { captureError = error; },
    async start() {
      const result = await send({ action: "start", backend: "webgpu", model: "test-model", videoId: discovered.videos[0].id });
      assert.equal(result.started, true);
      await created.promise;
      return result;
    },
    async ready() { initialization.resolve(gpu); await flush(); },
    stop() { return send({ action: "stop" }); },
    advance(time) { now = time; for (const [id, callback] of [...raf]) { raf.delete(id); callback(); } },
    present(mediaTime, presentedFrames = 1) {
      video.currentTime = mediaTime;
      const entry = callbacks.entries().next().value;
      assert.ok(entry, "live video must keep a requestVideoFrameCallback registered");
      callbacks.delete(entry[0]); entry[1](now, { mediaTime, presentedFrames });
    },
  };
  t.after(async () => {
    await app.stop();
    initialization.resolve(gpu);
    for (const operation of renders) operation.resolve();
    await flush();
    delete globalThis[factoryKey];
  });
  return app;
}

test("WebGPU reports the actual engine and separates waiting in the slot from rendering", async (t) => {
  const app = setup(t);
  app.gpu.info = { precision: "float16", precisionRequested: "auto", engineBuild: "test-build",
    adapter: { vendor: "nvidia", description: "RTX 3060", isFallbackAdapter: null } };
  await app.start(); await app.ready();
  assert.equal(app.messages.at(-1).diagnostics.adapter.vendor, "nvidia", "adapter is published before the first frame completes");
  app.advance(970); app.present(10.97, 2);
  app.advance(990);
  app.renders[0].resolve({ width: 8, height: 4 }); await flush();
  app.advance(1020);
  app.renders[1].resolve({ width: 8, height: 4, submitMs: 2, validationWaitMs: 1, completionWaitMs: 27 }); await flush();
  const status = app.messages.findLast((message) => message.type === "video-upscale:content-status");
  assert.equal(status.diagnostics.engineBuild, "test-build");
  assert.equal(status.diagnostics.inputWidth, 4);
  assert.equal(status.diagnostics.inputHeight, 2);
  assert.equal(status.diagnostics.outputWidth, 8);
  assert.equal(status.diagnostics.outputHeight, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(status.diagnostics.timings)), {
    captureMs: 0, queueWaitMs: 20, renderMs: 30, submitMs: 2,
    validationWaitMs: 1, completionWaitMs: 27, totalMs: 50,
  });
});

test("WebGPU keeps one render and one latest frame, replacing and closing excess captures", async (t) => {
  const app = setup(t);
  await app.start(); await app.ready();
  assert.equal(app.frames[0].closed, 1, "the VideoFrame capability probe is released");
  assert.equal(app.renders.length, 1);
  app.advance(40); app.present(10.04, 2);
  const replaced = app.frames.at(-1);
  app.advance(80); app.present(10.08, 3);
  assert.equal(app.renders.length, 1, "busy source callbacks cannot submit concurrent GPU work");
  assert.equal(replaced.closed, 1);
  assert.equal(app.host().dataset.upscalePending, "2");
  assert.equal(app.host().dataset.upscaleQueue, "1");
  assert.equal(app.frames.filter((frame) => !frame.closed).length, 2);
  app.advance(100);
  app.renders[0].resolve(); await flush();
  assert.equal(app.renders[0].input.closed, 1);
  assert.equal(app.host().style.visibility, "visible");
  assert.equal(app.host().dataset.upscalePending, "1");
  assert.equal(app.host().dataset.upscaleQueue, "0");
  assert.equal(app.renders.length, 2, "GPU completion immediately starts the queued frame without another callback");
  assert.equal(app.renders[1].input.timestamp, 10080000, "only the newest queued frame is rendered");
  app.advance(130);
  app.renders[1].resolve(); await flush();
  assert.equal(app.host().dataset.upscaleLatency, "50", "latency includes time waiting in the slot");
  app.advance(1100); app.present(11.1, 4);
  app.renders[2].resolve(); await flush();
  const status = app.messages.findLast((message) => message.type === "video-upscale:content-status");
  assert.equal(status.metrics.busySkippedFrames, 1, "queued frames that eventually render are not counted as skipped");
  assert.equal(app.host().dataset.upscalePending, "0");
  assert.equal(app.maximumInFlight(), 1);
  assert.equal(app.frames.every((frame) => frame.closed === 1), true);
});

test("WebGPU reports slow-model diagnostics when moving output is too old to display", async (t) => {
  const app = setup(t);
  await app.start(); await app.ready();
  app.advance(1100);
  app.renders[0].resolve({ width: 8, height: 4, submitMs: 1, validationWaitMs: 1, completionWaitMs: 1098 });
  await flush();
  const status = app.messages.findLast((message) => message.type === "video-upscale:content-status");
  assert.equal(status.phase, "waiting");
  assert.match(status.message, /Кадр опоздал: 1100 мс/);
  assert.equal(status.metrics.rejectedResults, 1);
  assert.equal(status.metrics.displayedFps, 0);
  assert.equal(status.diagnostics.timings.renderMs, 1100);
  assert.notEqual(app.host().style.visibility, "visible");
  assert.equal(app.video.paused, false, "the site retains playback control");
  app.video.paused = true; app.video.dispatch("pause");
  app.advance(1200);
  app.advance(2300);
  app.renders[1].resolve({ width: 8, height: 4 }); await flush();
  assert.equal(app.host().style.visibility, "visible", "the same timestamp remains useful for a paused quality comparison");
});

test("WebGPU discards an expired waiting frame before starting more GPU work", async (t) => {
  const app = setup(t);
  await app.start(); await app.ready();
  app.advance(40); app.present(10.04, 2);
  const queued = app.frames.at(-1);
  app.advance(401);
  app.renders[0].resolve(); await flush();
  assert.equal(app.renders.length, 1, "a queued frame older than the freshness limit must never render");
  assert.equal(queued.closed, 1);
  assert.equal(app.host().dataset.upscalePending, "0");
  assert.equal(app.host().dataset.upscaleQueue, "0");
  assert.notEqual(app.host().style.visibility, "visible");
  app.advance(1100); app.present(11.1, 3);
  app.renders[1].resolve(); await flush();
  const status = app.messages.findLast((message) => message.type === "video-upscale:content-status");
  assert.equal(status.metrics.busySkippedFrames, 1);
  assert.equal(status.metrics.rejectedResults, 1);
  assert.equal(app.host().style.visibility, "visible");
});

test("WebGPU immediately drains its bounded slot across 33/50ms source callback jitter", async (t) => {
  const app = setup(t);
  await app.start(); await app.ready();
  let sourceFrames = 1, completed = 0, maximumPending = 0, maximumQueue = 0;
  // Average source cadence is 25fps. Some callbacks arrive before the preceding
  // 34ms render settles; the later 50ms gap gives the GPU time to catch up.
  const offsets = new Set([33, 83, 116, 150, 0]);
  for (let time = 1; time <= 2040; time++) {
    app.advance(time);
    if (time <= 2000 && offsets.has(time % 200)) app.present(10 + time / 1000, ++sourceFrames);
    maximumPending = Math.max(maximumPending, Number(app.host().dataset.upscalePending));
    maximumQueue = Math.max(maximumQueue, Number(app.host().dataset.upscaleQueue));
    const operation = app.renders[completed];
    if (operation && operation.startedAt + 34 <= time) {
      completed++; operation.resolve(); await flush();
    }
  }
  assert.equal(sourceFrames, 51);
  assert.equal(completed, sourceFrames, "the jitter window must not drop otherwise affordable source frames");
  assert.equal(app.renders.length, sourceFrames);
  assert.equal(app.host().dataset.upscaleFrames, String(sourceFrames));
  assert.equal(maximumPending, 2);
  assert.equal(maximumQueue, 1);
  assert.equal(app.maximumInFlight(), 1);
  assert.equal(app.frames.every((frame) => frame.closed === 1), true);
  assert.ok(app.messages.filter((message) => message.metrics).every((message) => message.metrics.busySkippedFrames === 0));
});

test("WebGPU seek and resize reject late output and refresh a paused frame without changing the site player", async (t) => {
  const app = setup(t);
  app.video.paused = true;
  const before = { source: app.video.currentSrc, volume: app.video.volume, muted: app.video.muted, style: app.video.style.cssText };
  await app.start(); await app.ready();
  app.present(10.04, 2);
  const queuedBeforeSeek = app.frames.at(-1);
  app.video.seeking = true; app.video.currentTime = 60; app.video.dispatch("seeking");
  assert.equal(queuedBeforeSeek.closed, 1, "seek immediately releases the waiting decoded frame");
  app.renders[0].resolve(); await flush();
  assert.notEqual(app.host().style.visibility, "visible", "a completed pre-seek render must remain hidden");
  assert.equal(app.host().dataset.upscaleFrames, undefined);
  app.video.seeking = false; app.video.dispatch("seeked");
  app.advance(1100); app.present(60, 2);
  assert.equal(app.renders.length, 2);
  app.video.videoWidth = 8; app.video.videoHeight = 4; app.video.dispatch("resize");
  app.renders[1].resolve(); await flush();
  assert.notEqual(app.host().style.visibility, "visible", "old dimensions cannot resurface after resize");
  app.advance(1120);
  assert.equal(app.renders.length, 3);
  assert.equal(app.renders[2].input.displayWidth, 8);
  assert.equal(app.renders[2].input.displayHeight, 4);
  app.renders[2].resolve(); await flush();
  assert.equal(app.host().style.visibility, "visible");
  assert.equal(app.host().dataset.upscaleMediaTime, "60");
  const status = app.messages.findLast((message) => message.type === "video-upscale:content-status");
  assert.equal(status.phase, "paused");
  assert.ok(status.metrics.displayedFps > 0);
  app.advance(1200); app.advance(1500);
  assert.equal(app.renders.length, 3, "an unchanged paused frame is rendered only once");
  assert.deepEqual({ source: app.video.currentSrc, volume: app.video.volume, muted: app.video.muted, style: app.video.style.cssText }, before);
  assert.equal(app.frames.every((frame) => frame.closed === 1), true);
});

test("WebGPU stop destroys immediately but frees WASM only after a pending render settles", async (t) => {
  const app = setup(t);
  await app.start(); await app.ready();
  app.present(10.04, 2);
  const queued = app.frames.at(-1);
  await app.stop();
  assert.equal(queued.closed, 1, "stop immediately releases the waiting frame");
  assert.equal(app.gpu.destroyed, 1);
  assert.equal(app.gpu.freed, 0);
  assert.equal(app.host().isConnected, false);
  assert.equal(app.raf.size + app.callbacks.size + app.timers.size, 0);
  app.renders[0].resolve(); await flush();
  assert.equal(app.renders[0].input.closed, 1);
  assert.equal(app.gpu.freed, 1);
  assert.equal(app.host().dataset.upscaleFrames, undefined);
  assert.equal(app.renders.length, 1, "stop must not drain the queued frame");
  assert.equal(app.messages.some((message) => message.type === "video-upscale:content-closed"), false);
});

test("WebGPU render failures close input, release the engine and notify the extension", async (t) => {
  const app = setup(t);
  await app.start(); await app.ready();
  app.present(10.04, 2);
  const queued = app.frames.at(-1);
  app.renders[0].reject(Object.assign(new Error("GPU device lost"), { name: "InvalidStateError" })); await flush();
  assert.equal(app.renders[0].input.closed, 1);
  assert.equal(queued.closed, 1);
  assert.equal(app.renders.length, 1);
  assert.equal(app.gpu.destroyed, 1);
  assert.equal(app.gpu.freed, 1);
  assert.equal(app.host().isConnected, false);
  assert.equal(app.raf.size + app.callbacks.size + app.timers.size, 0);
  assert.match(app.messages.find((message) => message.type === "video-upscale:content-closed").error, /GPU device lost/);
});

test("WebGPU survives a transient VideoFrame constructor failure during a source change", async (t) => {
  const app = setup(t);
  await app.start(); await app.ready();
  app.renders[0].resolve(); await flush();
  assert.equal(app.host().style.visibility, "visible");
  app.video.currentSrc = "blob:https://site.example/next-episode";
  app.video.readyState = 1;
  app.present(0, 2);
  assert.equal(app.renders.length, 1, "a video without a decoded frame must not reach the GPU");
  app.video.readyState = 4;
  app.failCaptureOnce(Object.assign(new Error("The video no longer has a current frame"), { name: "InvalidStateError" }));
  app.present(0.04, 3);
  await flush();
  assert.equal(app.gpu.destroyed, 0, "a transient source swap must retain its loaded model");
  assert.equal(app.host().isConnected, true);
  assert.notEqual(app.host().style.visibility, "visible");
  assert.equal(app.messages.some((message) => message.type === "video-upscale:content-closed"), false);
  app.present(0.08, 4);
  assert.equal(app.renders.length, 2);
  app.renders[1].resolve(); await flush();
  assert.equal(app.host().style.visibility, "visible");
  assert.equal(app.host().dataset.upscaleMediaTime, "0.08");
  assert.equal(app.frames.every((frame) => frame.closed === 1), true);
});

test("stopping while the WebGPU model loads disposes a late engine without capturing frames", async (t) => {
  const app = setup(t);
  await app.start();
  assert.equal(app.creations.length, 1);
  await app.stop(); await app.ready();
  assert.equal(app.gpu.destroyed, 1);
  assert.equal(app.gpu.freed, 1);
  assert.equal(app.renders.length, 0);
  assert.equal(app.frames.length, 1, "only the already closed capability probe was created");
  assert.equal(app.frames[0].closed, 1);
  assert.equal(app.host().isConnected, false);
  assert.equal(app.messages.some((message) => message.type === "video-upscale:content-closed"), false);
});
