const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync("features/youtube-theater/player-state.js", "utf8");

function setup(player) {
  const document = new EventTarget();
  const events = [];
  let tick;
  const state = { player };
  document.getElementById = () => state.player;
  document.addEventListener("oe-youtube-player-state", (event) => {
    events.push(JSON.parse(JSON.stringify(event.detail)));
  });
  vm.runInNewContext(source, {
    document,
    CustomEvent: class extends Event {
      constructor(name, { detail }) { super(name); this.detail = detail; }
    },
    window: { setInterval: (callback) => { tick = callback; } },
  });
  return { state, document, events, tick: () => tick() };
}

test("current player API identifies a stream without the old ytp-live class", () => {
  const app = setup({
    getVideoData: () => ({ video_id: "stream", isLive: true }),
  });
  assert.deepEqual(app.events, [{ videoId: "stream", isLive: true }]);
  app.tick();
  assert.equal(app.events.length, 1, "Unchanged data is not broadcast repeatedly");
  app.document.dispatchEvent(new Event("oe-youtube-player-state-request"));
  assert.equal(app.events.length, 2, "Late content scripts can request the current state");
});

test("ended and upcoming broadcasts are not treated as live content", () => {
  for (const isLiveNow of [false, true]) {
    const app = setup({
      getVideoData: () => ({ video_id: "stream", isLive: true }),
      getPlayerResponse: () => ({
        videoDetails: { videoId: "stream", isLiveContent: true },
        microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow } } },
      }),
    });
    assert.equal(app.events[0].isLive, isLiveNow);
  }
});

test("unready, replaced and ended players are rechecked", () => {
  const app = setup(null);
  assert.deepEqual(app.events[0], { videoId: null, isLive: false });
  app.state.player = { getVideoData: () => ({ video_id: "stream", isLive: true }) };
  app.tick();
  assert.deepEqual(app.events.at(-1), { videoId: "stream", isLive: true });
  app.state.player = { getVideoData: () => ({ video_id: "stream", isLive: false }) };
  app.tick();
  assert.deepEqual(app.events.at(-1), { videoId: "stream", isLive: false });
});

test("temporary player API failures do not crash the bridge", () => {
  const app = setup({ getPlayerResponse() { throw new Error("Player is being replaced"); } });
  assert.deepEqual(app.events[0], { videoId: null, isLive: false });
  assert.doesNotThrow(() => app.tick());
});
