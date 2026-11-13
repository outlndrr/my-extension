(() => {
  let lastState = "";

  function publish(force = false) {
    let videoId = null;
    let isLive = false;
    try {
      const player = document.getElementById("movie_player");
      const response = player?.getPlayerResponse?.();
      const data = player?.getVideoData?.();
      const broadcast = response?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
      videoId = response?.videoDetails?.videoId ?? data?.video_id ?? null;
      isLive = (broadcast?.isLiveNow ?? data?.isLive) === true;
    } catch {
      // The player API can be temporarily unavailable while YouTube replaces it.
    }
    const key = `${videoId}:${isLive}`;
    if (force || key !== lastState) {
      lastState = key;
      document.dispatchEvent(new CustomEvent("oe-youtube-player-state", {
        detail: { videoId, isLive },
      }));
    }
  }

  document.addEventListener("oe-youtube-player-state-request", () => publish(true));
  document.addEventListener("yt-player-updated", () => publish());
  document.addEventListener("yt-navigate-finish", () => publish());
  // Player data can arrive after navigation events, or change when a broadcast ends.
  window.setInterval(publish, 1000);
  publish();
})();
