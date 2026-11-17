(() => {
  const ui = Object.fromEntries(["upscale-enabled", "upscale-model", "upscale-state"].map((id) => [id, document.getElementById(id)]));
  const models = new Set(Array.from(ui["upscale-model"].options, (option) => option.value));
  const defaultModel = "webgpu-fast";
  let tabId;
  let state = { enabled: false };
  let errorMessage = "";
  let refreshError = "";
  let busy = true;
  let polling = false;
  let revision = 0;
  let disposed = false;

  function render() {
    const enabled = state.enabled === true;
    ui["upscale-enabled"].checked = enabled;
    ui["upscale-enabled"].disabled = busy || !Number.isInteger(tabId);
    ui["upscale-model"].disabled = busy || enabled;
    if (enabled && models.has(state.model)) ui["upscale-model"].value = state.model;
    for (const option of ui["upscale-model"].options) {
      option.disabled = state.models?.find((model) => model.id === option.value)?.available === false;
    }
    ui["upscale-state"].textContent = errorMessage || refreshError || state.message || (enabled
      ? "Апскейл включён. Видео воспроизводится на вкладке."
      : "Включите апскейл поверх видео. Управление и звук остаются у плеера сайта.");
    ui["upscale-state"].dataset.tone = errorMessage || refreshError || state.phase === "error" ? "error" : enabled ? "ok" : "off";
  }

  async function message(action, values = {}) {
    const response = await chrome.runtime.sendMessage({ type: `video-upscale:${action}`, tabId, ...values });
    if (!response || typeof response !== "object") throw new Error("Обновите расширение и откройте меню ещё раз.");
    if (response.error) throw new Error(response.error);
    return response;
  }

  async function refresh() {
    if (busy || polling || disposed || !Number.isInteger(tabId)) return;
    polling = true;
    const readRevision = revision;
    try {
      const next = await message("get-state");
      if (readRevision !== revision || disposed) return;
      state = next;
      refreshError = "";
      render();
    } catch (error) {
      if (readRevision !== revision || disposed) return;
      refreshError = error.message;
      render();
    } finally {
      polling = false;
    }
  }

  ui["upscale-model"].addEventListener("change", async () => {
    errorMessage = "";
    try {
      await chrome.storage.local.set({ videoUpscaleWebGpuModel: ui["upscale-model"].value });
    } catch {
      errorMessage = "Не удалось сохранить выбранную модель.";
    }
    render();
  });

  ui["upscale-enabled"].addEventListener("change", async () => {
    if (busy) return;
    const enabled = ui["upscale-enabled"].checked;
    const model = ui["upscale-model"].value;
    const previous = state;
    revision++;
    busy = true;
    errorMessage = "";
    refreshError = "";
    state = { ...state, enabled, model, phase: enabled ? "starting" : "stopping",
      message: enabled ? "Подключение обработки кадров…" : "Выключение апскейла…" };
    render();
    try {
      state = enabled ? await message("start", { model }) : await message("stop");
    } catch (error) {
      state = previous;
      errorMessage = error.message;
    } finally {
      busy = false;
      render();
    }
  });

  async function initialize() {
    try {
      const [[tab], settings] = await Promise.all([
        chrome.tabs.query({ active: true, currentWindow: true }),
        chrome.storage.local.get({ videoUpscaleWebGpuModel: defaultModel }),
      ]);
      if (!Number.isInteger(tab?.id)) throw new Error("Нет активной вкладки. Откройте страницу с видео.");
      tabId = tab.id;
      ui["upscale-model"].value = models.has(settings.videoUpscaleWebGpuModel) ? settings.videoUpscaleWebGpuModel : defaultModel;
      state = await message("get-state");
    } catch (error) {
      errorMessage = error.message;
    } finally {
      busy = false;
      render();
    }
  }

  const timer = setInterval(refresh, 1000);
  window.addEventListener("pagehide", () => {
    disposed = true;
    clearInterval(timer);
  });
  initialize();
})();
