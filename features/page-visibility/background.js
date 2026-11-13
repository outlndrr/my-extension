(() => {
  const setting = "pageVisibilityEnabled";
  // Registered dynamically: a static MAIN-world script cannot read the setting before page scripts run.
  const script = {
    id: "page-visibility",
    js: ["features/page-visibility/inject.js"],
    matches: ["<all_urls>"],
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: "document_start",
    world: "MAIN",
  };
  let queue = Promise.resolve();

  async function sync() {
    const settings = await chrome.storage.local.get({ [setting]: true });
    const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] });
    if (settings[setting] === false) {
      if (registered) await chrome.scripting.unregisterContentScripts({ ids: [script.id] });
    } else if (registered) {
      await chrome.scripting.updateContentScripts([script]);
    } else {
      await chrome.scripting.registerContentScripts([script]);
    }
  }

  // Serialized so two quick toggles cannot both try to register the same id.
  function schedule() {
    queue = queue.then(sync).catch((error) => {
      console.warn("Outlndrr: не удалось обновить скрытие переключения вкладок.", error);
    });
    return queue;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.hasOwn(changes, setting)) schedule();
  });
  schedule();
})();
