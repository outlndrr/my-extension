const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync("features/youtube-theater/content.js", "utf8");

async function setup(saved = true, { storageError = false, deferSettings = false } = {}) {
  class Watch {
    attributes = new Map([["theater", ""], ["video-id", "live123"]]);
    style = new Map();
    constructor() {
      this.style.setProperty = this.style.set.bind(this.style);
      this.style.removeProperty = this.style.delete.bind(this.style);
    }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelector(selector) {
      if (selector === "ytd-live-chat-frame#chat") return state.chat;
      throw new Error(`Unexpected selector: ${selector}`);
    }
  }
  const state = { headerBottom: 56, collapsed: false, hiddenChat: false };
  state.chat = {
    hasAttribute: (name) => name === "collapsed" && state.collapsed,
    closest: () => state.hiddenChat ? {} : null,
  };
  state.watch = new Watch();
  const document = new EventTarget();
  document.documentElement = {};
  document.fullscreenElement = null;
  document.querySelector = (selector) => {
    if (selector === "ytd-watch-flexy") return state.watch;
    if (selector === "ytd-masthead") {
      return { getBoundingClientRect: () => ({ bottom: state.headerBottom }) };
    }
    throw new Error(`Unexpected selector: ${selector}`);
  };
  const media = new EventTarget();
  media.matches = true;
  const window = new EventTarget();
  window.matchMedia = () => media;
  const frames = [];
  window.requestAnimationFrame = (callback) => frames.push(callback);
  let onStorageChange;
  let onMutation;
  let resolveSettings;
  let warnings = 0;
  const settings = new Promise((resolve, reject) => {
    resolveSettings = resolve;
    if (storageError) reject(new Error("Storage unavailable"));
    else if (!deferSettings) resolve({ youtubeTheaterEnabled: saved });
  });
  const location = { href: "https://www.youtube.com/watch?v=live123" };
  vm.runInNewContext(source, {
    document, window, location, URL, Event,
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe() {}
    },
    chrome: { storage: {
      local: { get: () => settings },
      onChanged: { addListener: (callback) => { onStorageChange = callback; } },
    } },
    console: { warn: () => { warnings++; } },
  });
  function flush() {
    let runs = 0;
    while (frames.length) {
      assert.ok(runs++ < 10, "Layout must settle, not cause an endless resize loop");
      frames.shift()();
    }
  }
  function emitPlayer(isLive = true, videoId = "live123") {
    document.dispatchEvent(Object.assign(new Event("oe-youtube-player-state"), {
      detail: { videoId, isLive },
    }));
    flush();
  }
  document.addEventListener("oe-youtube-player-state-request", () => emitPlayer());
  emitPlayer();
  await new Promise(setImmediate);
  flush();
  return {
    state, document, window, media, location, flush, Watch, emitPlayer,
    mode: () => state.watch?.getAttribute("data-oe-youtube-theater") ?? null,
    mutate: () => { onMutation(); flush(); },
    setting: (value, area = "local") => {
      onStorageChange({ youtubeTheaterEnabled: { newValue: value } }, area);
      flush();
    },
    resolveSettings, warnings: () => warnings,
    event: (name) => { document.dispatchEvent(new Event(name)); flush(); },
  };
}

test("live theater enables layout and tracks header height", async () => {
  const app = await setup();
  assert.equal(app.mode(), "expanded");
  assert.equal(app.state.watch.style.get("--oe-youtube-header-height"), "56px");
  app.state.headerBottom = 72;
  app.mutate();
  assert.equal(app.state.watch.style.get("--oe-youtube-header-height"), "72px");
});

test("saved switch and runtime changes apply without page reload", async () => {
  const app = await setup(false);
  assert.equal(app.mode(), null);
  app.setting(true, "sync");
  assert.equal(app.mode(), null);
  app.setting(true);
  assert.equal(app.mode(), "expanded");
  app.state.watch.style.set("unrelated-property", "keep");
  app.setting(false);
  assert.equal(app.mode(), null);
  assert.equal(app.state.watch.style.has("--oe-youtube-header-height"), false);
  assert.equal(app.state.watch.style.get("unrelated-property"), "keep");
  app.setting(undefined);
  assert.equal(app.mode(), "expanded", "Deleted preference restores enabled default");
});

test("only live videos in theater on a matching watch page are affected", async () => {
  const cases = [
    (app) => { app.emitPlayer(false); },
    (app) => { app.emitPlayer(true, "previous-video"); },
    (app) => { app.state.watch.removeAttribute("theater"); },
    (app) => { app.state.watch.setAttribute("hidden", ""); },
    (app) => { app.state.watch.setAttribute("fullscreen", ""); },
    (app) => { app.document.fullscreenElement = {}; },
    (app) => { app.media.matches = false; },
    (app) => { app.location.href = "https://www.youtube.com/"; },
    (app) => { app.location.href = "https://www.youtube.com/shorts/live123"; },
    (app) => { app.location.href = "https://www.youtube.com/@channel/videos"; },
    (app) => { app.location.href = "https://www.youtube.com/live/other"; },
    (app) => { app.location.href = "https://www.youtube.com/watch"; },
    (app) => { app.location.href = "https://www.youtube.com/watch?v=other"; },
    (app) => { app.state.watch = null; },
  ];
  for (const change of cases) {
    const app = await setup();
    const oldWatch = app.state.watch;
    change(app);
    app.mutate();
    assert.equal(app.mode(), null, change.toString());
    assert.equal(oldWatch.hasAttribute("data-oe-youtube-theater"), false);
  }
});

test("direct live links and channel live aliases enable the same layout", async () => {
  const app = await setup();
  for (const path of ["/live/live123", "/live/live123?si=share", "/@LofiGirl/live",
    "/channel/UC123/live", "/c/creator/live", "/user/creator/live"]) {
    app.location.href = `https://www.youtube.com${path}`;
    app.mutate();
    assert.equal(app.mode(), "expanded", path);
  }
});

test("invalid page-world state cannot activate the layout", async () => {
  const app = await setup();
  app.emitPlayer(false);
  for (const detail of [null, {}, { videoId: 123, isLive: true },
    { videoId: "live123", isLive: "true" }]) {
    app.document.dispatchEvent(Object.assign(new Event("oe-youtube-player-state"), { detail }));
    app.flush();
    assert.equal(app.mode(), null);
  }
  app.emitPlayer(true);
  assert.equal(app.mode(), "expanded");
});

test("native chat collapse, expansion, missing chat and hidden chat", async () => {
  const app = await setup();
  const chat = app.state.chat;
  app.state.collapsed = true;
  app.mutate();
  assert.equal(app.mode(), "collapsed");
  app.state.collapsed = false;
  app.mutate();
  assert.equal(app.mode(), "expanded");
  app.state.chat = null;
  app.mutate();
  assert.equal(app.mode(), "no-chat");
  app.state.chat = chat;
  app.state.hiddenChat = true;
  app.mutate();
  assert.equal(app.mode(), "no-chat");
});

test("SPA navigation clears layout and handles replaced watch elements", async () => {
  const app = await setup();
  const oldWatch = app.state.watch;
  app.event("yt-navigate-start");
  assert.equal(app.mode(), null);
  app.mutate();
  assert.equal(app.mode(), null, "No activation during navigation");
  app.state.watch = new app.Watch();
  app.event("yt-navigate-finish");
  assert.equal(app.mode(), "expanded");
  assert.equal(oldWatch.hasAttribute("data-oe-youtube-theater"), false);
  const replacedWatch = app.state.watch;
  app.state.watch = new app.Watch();
  app.mutate();
  assert.equal(replacedWatch.hasAttribute("data-oe-youtube-theater"), false);
  assert.equal(app.mode(), "expanded");
});

test("fullscreen, theater and responsive changes are reversible", async () => {
  const app = await setup();
  app.document.fullscreenElement = {};
  app.event("fullscreenchange");
  assert.equal(app.mode(), null);
  app.document.fullscreenElement = null;
  app.event("fullscreenchange");
  assert.equal(app.mode(), "expanded");
  app.state.watch.removeAttribute("theater");
  app.mutate();
  assert.equal(app.mode(), null);
  app.state.watch.setAttribute("theater", "");
  app.mutate();
  assert.equal(app.mode(), "expanded");
  app.media.matches = false;
  app.media.dispatchEvent(new Event("change"));
  app.flush();
  assert.equal(app.mode(), null);
  app.media.matches = true;
  app.media.dispatchEvent(new Event("change"));
  app.flush();
  assert.equal(app.mode(), "expanded");
});

test("a failed settings read leaves YouTube untouched", async () => {
  const app = await setup(true, { storageError: true });
  assert.equal(app.mode(), null);
  assert.equal(app.warnings(), 1);
});

test("a slow initial settings read cannot overwrite a newer switch change", async () => {
  const app = await setup(true, { deferSettings: true });
  assert.equal(app.mode(), null);
  app.setting(false);
  app.resolveSettings({ youtubeTheaterEnabled: true });
  await new Promise(setImmediate);
  app.flush();
  assert.equal(app.mode(), null);
});
