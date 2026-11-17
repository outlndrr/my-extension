(() => {
  const maxPixels = 1920 * 1080;
  const maxAgeMs = 300;

  function dimensions(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= maxPixels;
  }

  function fresh(frame, { now, mediaTime, paused, playbackRate = 1 }) {
    if (!Number.isFinite(mediaTime) || Math.abs(mediaTime - frame.mediaTime) > (paused ? 0.05 : 0.35 * Math.max(1, playbackRate))) return false;
    return paused || now - frame.capturedAt <= maxAgeMs;
  }

  // A valid result must survive until the next result arrives, without retaining a stalled frame.
  function displayFresh(frame, { now, mediaTime, paused, playbackRate = 1 }) {
    if (!frame || !Number.isFinite(mediaTime)) return false;
    if (Math.abs(mediaTime - frame.mediaTime) > (paused ? 0.05 : 0.65 * Math.max(1, playbackRate))) return false;
    return paused || now - frame.capturedAt <= 600;
  }

  globalThis.__outlndrrLiveFramesV1 = { fresh, displayFresh, dimensions, maxAgeMs };
})();
