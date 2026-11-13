(() => {
  const setting = "youtubeTheaterEnabled";
  const attribute = "data-oe-youtube-theater";
  const headerProperty = "--oe-youtube-header-height";
  const wideScreen = window.matchMedia("(min-width: 960px)");
  let enabled = null;
  let playerState = null;
  let navigating = false;
  let scheduled = false;
  let currentWatch = null;
  let layoutKey = "";

  function update() {
    scheduled = false;
    const watch = document.querySelector("ytd-watch-flexy");
    const url = new URL(location.href);
    const directLiveId = url.pathname.match(/^\/live\/([^/]+)\/?$/)?.[1];
    const channelLive = /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/.test(url.pathname);
    const videoId = url.pathname === "/watch" ? url.searchParams.get("v")
      : directLiveId ?? (channelLive ? watch?.getAttribute("video-id") : null);
    const active =
      enabled === true &&
      !navigating &&
      Boolean(videoId) &&
      watch?.getAttribute("video-id") === videoId &&
      watch.hasAttribute("theater") &&
      !watch.hasAttribute("hidden") &&
      !watch.hasAttribute("fullscreen") &&
      !document.fullscreenElement &&
      wideScreen.matches &&
      playerState?.videoId === videoId &&
      playerState.isLive;

    if (currentWatch && (!active || currentWatch !== watch)) {
      currentWatch.removeAttribute(attribute);
      currentWatch.style.removeProperty(headerProperty);
    }

    let nextKey = "";
    if (active) {
      const chat = watch.querySelector("ytd-live-chat-frame#chat");
      const state = !chat || chat.closest("[hidden]")
        ? "no-chat"
        : chat.hasAttribute("collapsed") ? "collapsed" : "expanded";
      const masthead = document.querySelector("ytd-masthead");
      const headerBottom = Math.max(0, Math.round(
        masthead ? masthead.getBoundingClientRect().bottom : 56,
      ));
      nextKey = `${state}:${headerBottom}`;
      if (currentWatch !== watch || layoutKey !== nextKey) {
        watch.setAttribute(attribute, state);
        watch.style.setProperty(headerProperty, `${headerBottom}px`);
      }
    }

    const changed = currentWatch !== (active ? watch : null) || layoutKey !== nextKey;
    currentWatch = active ? watch : null;
    layoutKey = nextKey;
    if (changed) {
      // YouTube recalculates native player controls after the CSS layout changes.
      window.dispatchEvent(new Event("resize"));
    }
  }

  function schedule() {
    if (!scheduled) {
      scheduled = true;
      window.requestAnimationFrame(update);
    }
  }

  document.addEventListener("oe-youtube-player-state", (event) => {
    const detail = event.detail;
    if (!detail || (detail.videoId !== null && typeof detail.videoId !== "string") ||
        typeof detail.isLive !== "boolean") return;
    playerState = { videoId: detail.videoId, isLive: detail.isLive };
    schedule();
  });
  document.dispatchEvent(new Event("oe-youtube-player-state-request"));

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["theater", "fullscreen", "hidden", "collapsed", "video-id", "class"],
  });

  document.addEventListener("yt-navigate-start", () => {
    navigating = true;
    playerState = null;
    update();
  });
  document.addEventListener("yt-navigate-finish", () => {
    navigating = false;
    document.dispatchEvent(new Event("oe-youtube-player-state-request"));
    schedule();
  });
  document.addEventListener("yt-player-updated", schedule);
  document.addEventListener("fullscreenchange", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, { passive: true });
  wideScreen.addEventListener("change", schedule);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, setting)) {
      enabled = changes[setting].newValue !== false;
      schedule();
    }
  });

  chrome.storage.local.get({ [setting]: true }).then((settings) => {
    if (enabled === null) enabled = settings[setting] !== false;
    schedule();
  }).catch((error) => {
    console.warn("Outlndrr: не удалось прочитать настройки YouTube.", error);
  });
})();
