(() => {
  const prefix = "video-upscale:";
  const stateKey = (tabId) => `videoUpscaleTab:${tabId}`;
  const popupUrl = chrome.runtime.getURL("popup/index.html");
  const models = [{ id: "webgpu-fast", name: "WebGPU Fast", available: true },
    { id: "webgpu-quality", name: "WebGPU Quality", available: true }];
  const queues = new Map();

  function serial(tabId, work) {
    const previous = queues.get(tabId) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queues.set(tabId, next);
    next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
    return next;
  }

  async function read(tabId) {
    return (await chrome.storage.session.get(stateKey(tabId)))[stateKey(tabId)];
  }

  async function save(tabId, state) {
    await chrome.storage.session.set({ [stateKey(tabId)]: state });
  }

  function publicState(state) {
    return {
      enabled: Boolean(state?.enabled), phase: state?.phase || "idle",
      message: state?.message || "Выберите модель и включите апскейлинг для видео на этой вкладке.",
      model: state?.model || models[0].id, models,
    };
  }

  async function sendContent(tabId, state, action, extra = {}) {
    return chrome.tabs.sendMessage(tabId, { type: `${prefix}content`, action, id: state.id, ...extra }, { frameId: state.ownerFrame });
  }

  async function stop(tabId, message = "Апскейлинг выключен. Плеер сайта продолжает работать.", phase = "idle") {
    const state = await read(tabId);
    if (!state?.enabled) return publicState(state);
    state.enabled = false;
    await save(tabId, state);
    await sendContent(tabId, state, "stop").catch(() => null);
    const ended = { enabled: false, phase, message, model: state.model };
    await save(tabId, ended);
    return publicState(ended);
  }

  async function start(tabId, message) {
    const previous = await read(tabId);
    if (previous?.enabled) return publicState(previous);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // A tab can report status "loading" with only pendingUrl for a while after its page loaded.
    if (!/^https?:\/\//i.test(tab?.url || tab?.pendingUrl || "")) {
      throw new Error("Апскейлинг доступен только на HTTP(S)-сайтах.");
    }
    const model = message.model || models[0].id;
    if (!models.some((item) => item.id === model)) throw new Error("Неизвестная модель апскейлинга.");
    let frames;
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, files: ["features/video-upscale/live-frame-core.js", "features/video-upscale/inpage-content.js"],
      });
    } catch {
      throw new Error("На этой странице нельзя включить апскейлинг. Откройте обычную страницу с видео.");
    }
    const candidates = frames.flatMap((frame) => (frame.result?.videos || []).map((video) => ({ ...video, frameId: frame.frameId })));
    const visible = candidates.filter((video) => video.visible);
    const eligible = visible.filter((video) => !video.error).sort((a, b) => Number(a.paused) - Number(b.paused) || b.area - a.area);
    const selected = eligible[0];
    if (!selected) {
      const largest = visible.sort((a, b) => b.area - a.area)[0];
      throw new Error(largest?.error || "На вкладке не найдено видимое видео. Запустите ролик и повторите.");
    }
    const state = {
      id: crypto.randomUUID(), enabled: true, phase: "starting", message: "Подключение обработки кадров. Плеер сайта продолжает работать…",
      model, ownerFrame: selected.frameId, createdAt: Date.now(),
    };
    await save(tabId, state);
    try {
      const result = await sendContent(tabId, state, "start", { videoId: selected.id, model });
      if (result?.error) throw new Error(result.error);
      if (!result?.started) throw new Error("Плеер изменился. Повторите включение апскейлинга.");
    } catch (error) {
      await stop(tabId, error.message, "error");
      throw error;
    }
    return publicState(state);
  }

  async function getState(tabId) {
    const state = await read(tabId);
    if (state?.enabled && Date.now() - state.createdAt > 10000) {
      const alive = await sendContent(tabId, state, "probe").catch(() => null);
      if (!alive?.active) return stop(tabId, "Плеер был закрыт или страница изменилась. Апскейлинг остановлен.");
    }
    return publicState(state);
  }

  async function updateStatus(tabId, state, message) {
    state.phase = ["preparing", "buffering", "playing", "paused", "finished", "waiting", "fallback", "error"].includes(message.phase) ? message.phase : "preparing";
    state.message = String(message.message || "Подготовка видео…").slice(0, 500);
    const { sourceFps, displayedFps, latencyMs } = message.metrics || {};
    const number = (value) => Number.isFinite(value) && value >= 0;
    if (state.phase === "playing" && number(displayedFps) && number(latencyMs)) {
      const source = number(sourceFps) ? ` из ${Math.min(240, sourceFps).toFixed(0)}` : "";
      state.message += ` · ${Math.min(240, displayedFps).toFixed(0)}${source} кадр/с · кадр ${Math.min(300000, latencyMs).toFixed(0)} мс`;
    }
    await save(tabId, state);
    if (state.phase === "error") return stop(tabId, state.message, "error");
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message?.type?.startsWith(prefix)) return;
    let work;
    if ([`${prefix}get-state`, `${prefix}start`, `${prefix}stop`].includes(message.type)) {
      if (sender.url !== popupUrl || sender.tab || !Number.isInteger(message.tabId) || message.tabId < 0) {
        reply({ error: "Команда доступна только из попапа расширения." });
        return;
      }
      work = () => message.type === `${prefix}start` ? start(message.tabId, message)
        : message.type === `${prefix}stop` ? stop(message.tabId) : getState(message.tabId);
    } else if (message.type === `${prefix}content-status` && Number.isInteger(sender.tab?.id)) {
      work = async () => {
        const state = await read(sender.tab.id);
        if (state?.enabled && state.id === message.id && state.ownerFrame === sender.frameId) {
          return updateStatus(sender.tab.id, state, message);
        }
        return { ok: false };
      };
    } else if (message.type === `${prefix}content-closed` && Number.isInteger(sender.tab?.id)) {
      work = async () => {
        const state = await read(sender.tab.id);
        if (state?.enabled && state.id === message.id && state.ownerFrame === sender.frameId) {
          return stop(sender.tab.id, message.error ? String(message.error).slice(0, 500) : "Страница или исходное видео изменились. Апскейлинг остановлен.", message.error ? "error" : "idle");
        }
        return { ok: true };
      };
    } else return;
    serial(message.tabId ?? sender.tab.id, work).then(reply, (error) => reply({ error: error.message }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    serial(tabId, () => chrome.storage.session.remove(stateKey(tabId))).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== "loading") return;
    serial(tabId, () => stop(tabId, "Страница перезагружена. Апскейлинг остановлен.")).catch(() => {});
  });
})();
