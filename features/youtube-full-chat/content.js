(() => {
  if (location.pathname !== "/live_chat") return;

  const setting = "youtubeFullChatEnabled";
  const attribute = "data-oe-youtube-full-chat";
  let enabled = null;

  function update() {
    const root = document.documentElement;
    if (enabled !== true) {
      root.removeAttribute(attribute);
      return;
    }

    const selector = document.querySelector("yt-live-chat-header-renderer #view-selector");
    const options = selector?.querySelectorAll("tp-yt-paper-listbox#menu > a");
    // shortcut: YouTube orders these as top chat, then live chat; stop if the menu structure changes.
    if (options?.length !== 2) {
      root.removeAttribute(attribute);
      return;
    }

    const liveChat = options[1];
    if (liveChat.getAttribute("aria-selected") !== "true") {
      liveChat.click();
    }
    root.toggleAttribute(attribute, liveChat.getAttribute("aria-selected") === "true");
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, setting)) {
      enabled = changes[setting].newValue !== false;
      update();
    }
  });

  chrome.storage.local.get({ [setting]: true }).then((settings) => {
    if (enabled === null) enabled = settings[setting] !== false;
    update();
  }).catch((error) => {
    console.warn("Outlndrr: не удалось прочитать настройку полного чата.", error);
  });

  // Chat can initialize late or reset the selected mode without reloading its iframe.
  window.setInterval(update, 1000);
})();
