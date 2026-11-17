const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const coreSource = readFileSync("features/video-upscale/live-frame-core.js", "utf8");
const contentSource = readFileSync("features/video-upscale/inpage-content.js", "utf8");

// Injection returns the page's eligible videos; WebGPU playback itself is covered in video-upscale-webgpu-live.
function discover({ source = "blob:https://site.example/session", srcObject = null, effectiveOrigin = "https://site.example", locationOrigin = "https://site.example", protocol = "https:" } = {}) {
  const events = (target = {}) => Object.assign(target, { addEventListener() {}, removeEventListener() {} });
  const video = events({
    isConnected: true, videoWidth: 4, videoHeight: 2, readyState: 4, currentSrc: source, src: "", srcObject,
    duration: Infinity, currentTime: 10, paused: false, controls: false, seeking: false,
    style: { cssText: "visibility:visible!important" },
    getBoundingClientRect: () => ({ top: 20, left: 30, width: 640, height: 360, bottom: 380, right: 670 }),
  });
  const context = vm.createContext({
    document: events({ fullscreenElement: null, pictureInPictureElement: null, hidden: false,
      querySelectorAll: (selector) => selector === "video" ? [video] : [] }),
    window: events(), origin: effectiveOrigin, location: { protocol, origin: locationOrigin },
    URL, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    chrome: { runtime: { id: "extension", onMessage: { addListener() {} }, async sendMessage() {} } },
  });
  vm.runInContext(coreSource, context);
  return vm.runInContext(contentSource, context).videos;
}

test("MediaStream sources and infinite-duration MSE sources are eligible", () => {
  const [video] = discover({ source: "", srcObject: {} });
  assert.equal(video.error, undefined);
  assert.equal(video.origin, "https://site.example");
});

test("effective document origin permits inherited srcdoc/blob frames and excludes opaque sandbox frames", () => {
  assert.equal(discover({ protocol: "about:", locationOrigin: "null" })[0].origin, "https://site.example");
  assert.equal(discover({ protocol: "blob:" }).length, 1);
  assert.equal(discover({ effectiveOrigin: "null" }).length, 0);
});
