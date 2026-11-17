(() => {
  // Unlike location.origin, this includes inherited srcdoc/about:blank origins and rejects sandboxed opaque documents.
  const ownerOrigin = globalThis.origin;
  if (!/^https?:\/\//i.test(ownerOrigin || "")) return { videos: [] };
  const key = "__outlndrrInpageUpscaleV1";
  if (globalThis[key]) return globalThis[key].list();
  const core = globalThis.__outlndrrLiveFramesV1;
  const videos = new Map();
  let nextId = 0;
  let active;

  function list() {
    const found = [];
    function visit(root) {
      found.push(...root.querySelectorAll("video"));
      for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
    }
    visit(document);
    for (const [id, video] of videos) if (!found.includes(video)) videos.delete(id);
    return { videos: found.slice(0, 30).map((video) => {
      let id = [...videos].find(([, item]) => item === video)?.[0];
      if (!id) { id = String(++nextId); videos.set(id, video); }
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      let error;
      if (video.mediaKeys) error = "Видео защищено DRM. Захват кадров этого видео недоступен.";
      else if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) error = "Дождитесь загрузки первого кадра видео.";
      else if (!core?.dimensions(video.videoWidth, video.videoHeight)) error = "Для апскейлинга выберите исходное видео не выше 1080p.";
      return {
        id, origin: ownerOrigin, source: video.currentSrc || video.src || "", error, paused: video.paused, time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        area: Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)),
        visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
        properties: { volume: video.volume, muted: video.muted, playbackRate: video.playbackRate },
      };
    }) };
  }

  function notifyClosed(state, error) {
    chrome.runtime.sendMessage({ type: "video-upscale:content-closed", id: state.id, error }).catch(() => {});
  }

  function updateGpuQueue(state) {
    state.host.dataset.upscalePending = String(Number(Boolean(state.gpuBusy)) + Number(Boolean(state.pendingGpu)));
    state.host.dataset.upscaleQueue = state.pendingGpu ? "1" : "0";
  }

  function discardPendingGpu(state) {
    if (state.pendingGpu) {
      state.pendingGpu.input.close();
      state.pendingGpu = undefined;
      state.busySkipped++;
    }
    updateGpuQueue(state);
  }

  function stop(notify = false, error) {
    const state = active;
    if (!state) return;
    active = undefined;
    clearInterval(state.timer);
    cancelAnimationFrame(state.animation);
    if (state.callback !== undefined) state.video.cancelVideoFrameCallback?.(state.callback);
    state.resize.disconnect();
    for (const [target, type, handler, options] of state.listeners) target.removeEventListener(type, handler, options);
    discardPendingGpu(state);
    state.gpu?.destroy();
    if (!state.gpuBusy) { state.gpu?.free(); state.gpu = undefined; }
    state.host.remove();
    if (notify) notifyClosed(state, error);
  }

  function captureError(error) {
    return error?.name === "SecurityError"
      ? "Сайт запрещает чтение кадров этого видео (CORS). Blob/MSE поддерживается, когда браузер разрешает доступ к кадрам. Исходный плеер продолжает работать."
      : `Не удалось прочитать кадр видео: ${error?.message || "кадр недоступен"}. Исходный плеер продолжает работать.`;
  }

  async function start(message) {
    stop();
    const video = videos.get(message.videoId);
    if (!video?.isConnected) return { error: "Исходное видео исчезло. Повторите включение апскейлинга." };
    const selected = list().videos.find((item) => item.id === message.videoId);
    if (selected?.error) return { error: selected.error };
    if (!selected) return { error: "Исходное видео не найдено." };
    try {
      if (typeof VideoFrame !== "function") throw new Error("Обновите Chrome/Edge: необходима поддержка VideoFrame.");
      new VideoFrame(video).close();
    } catch (error) { return { error: captureError(error) }; }

    const host = document.createElement("div");
    host.setAttribute("data-outlndrr-upscale", "");
    host.dataset.upscaleBackend = "webgpu";
    host.style.cssText = "all: initial; display: block; position: absolute; pointer-events: none !important; margin: 0; padding: 0; border: 0; overflow: hidden; visibility: hidden;";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display: block; width: 100%; height: 100%; pointer-events: none !important; margin: 0; padding: 0; border: 0;";
    host.attachShadow({ mode: "closed" }).append(canvas);
    video.after(host);

    const state = active = {
      id: message.id, generation: 0, video, host, canvas, listeners: [],
      source: video.currentSrc || video.src, sourceObject: video.srcObject, width: video.videoWidth, height: video.videoHeight,
      ready: false, eligible: false, visible: false,
      lastStatus: 0, completed: 0, shown: 0, dropped: 0, sourceFrames: 0, busySkipped: 0, sampleAt: performance.now(),
    };

    function listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      state.listeners.push([target, type, handler, options]);
    }
    function hide() {
      if (state.visible) { host.style.visibility = "hidden"; state.visible = false; }
    }
    function invalidate() {
      state.generation++;
      discardPendingGpu(state);
      state.displayed = undefined;
      state.lastCapturedTime = undefined;
      state.lastObservedTime = undefined;
      state.lastPresentedFrames = undefined;
      hide();
    }
    function current() {
      return { now: performance.now(), mediaTime: state.video.currentTime, paused: state.video.paused, playbackRate: state.video.playbackRate };
    }
    function status(phase, message, force = false) {
      const now = performance.now();
      if (!force && now - state.lastStatus < 1000) return;
      state.lastStatus = now;
      const elapsed = Math.max(0.001, (now - state.sampleAt) / 1000);
      const update = { type: "status", phase, message, metrics: {
        processedFps: state.completed / elapsed, displayedFps: state.shown / elapsed,
        sourceFps: state.sourceFrames / elapsed, busySkippedFrames: state.busySkipped,
        rejectedResults: state.dropped, queueDepth: Number(Boolean(state.pendingGpu)),
        droppedFrames: state.dropped, latencyMs: state.latencyMs || 0,
        ...(state.visible && state.displayed ? { pictureDelayMs: Math.max(0,
          (state.video.currentTime - state.displayed.mediaTime) / Math.max(0.25, Math.abs(state.video.playbackRate || 1)) * 1000) } : {}),
      } };
      if (state.diagnostics) update.diagnostics = state.diagnostics;
      chrome.runtime.sendMessage({ ...update, type: "video-upscale:content-status", id: state.id }).catch(() => {});
      state.sampleAt = now; state.completed = 0; state.shown = 0; state.dropped = 0; state.sourceFrames = 0; state.busySkipped = 0;
    }
    function fallbackReason() {
      const item = state.video;
      if (document.fullscreenElement === item) return "Полноэкранный режим самого video: показывается исходное видео. Апскейлинг вернётся после выхода.";
      if (document.pictureInPictureElement === item) return "В режиме «картинка в картинке» показывается исходное видео.";
      if (Array.from(item.textTracks || []).some((track) => track.mode === "showing")) return "Включены встроенные субтитры: показывается исходное видео, чтобы сохранить текст.";
      if (item.controls && (item.matches(":hover") || item.matches(":focus-visible"))) return "Управление плеером: показывается исходное видео.";
    }
    state.update = () => {
      if (active !== state) return;
      const item = state.video;
      if (!item.isConnected) {
        const replacement = list().videos.filter((candidate) => candidate.visible && !candidate.error).sort((a, b) => Number(a.paused) - Number(b.paused) || b.area - a.area)[0];
        if (!replacement) {
          if (state.eligible) invalidate();
          state.eligible = false; hide(); status("waiting", "Ожидание следующего видео на странице."); return;
        }
        attachVideo(videos.get(replacement.id));
      }
      const target = state.video;
      if (target.mediaKeys) { stop(true, "Видео защищено DRM. Захват кадров недоступен."); return; }
      if (state.source !== (target.currentSrc || target.src) || state.sourceObject !== target.srcObject || state.width !== target.videoWidth || state.height !== target.videoHeight) {
        invalidate();
        state.source = target.currentSrc || target.src;
        state.sourceObject = target.srcObject;
        state.width = target.videoWidth; state.height = target.videoHeight;
      }
      if (host.parentNode !== target.parentNode || target.nextSibling !== host) target.after(host);
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      const reason = fallbackReason();
      const wasEligible = state.eligible;
      state.eligible = !document.hidden && !reason && !target.seeking && target.readyState >= 2 && core.dimensions(target.videoWidth, target.videoHeight)
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      if (!state.eligible) {
        if (wasEligible) invalidate();
        hide(); status("waiting", reason || "Апскейлинг ожидает видимый кадр видео."); return;
      }
      const offsetParent = host.offsetParent;
      const parent = offsetParent === document.body && getComputedStyle(offsetParent).position === "static" ? null : offsetParent;
      const bounds = parent?.getBoundingClientRect();
      const scaleX = bounds && parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
      const scaleY = bounds && parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
      const leftInset = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
      const topInset = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
      const rightInset = (parseFloat(style.borderRightWidth) || 0) + (parseFloat(style.paddingRight) || 0);
      const bottomInset = (parseFloat(style.borderBottomWidth) || 0) + (parseFloat(style.paddingBottom) || 0);
      host.style.left = `${(rect.left - (bounds?.left || 0)) / scaleX + (parent ? parent.scrollLeft - parent.clientLeft : scrollX) + leftInset}px`;
      host.style.top = `${(rect.top - (bounds?.top || 0)) / scaleY + (parent ? parent.scrollTop - parent.clientTop : scrollY) + topInset}px`;
      host.style.width = `${Math.max(0, rect.width / scaleX - leftInset - rightInset)}px`;
      host.style.height = `${Math.max(0, rect.height / scaleY - topInset - bottomInset)}px`;
      host.style.zIndex = style.zIndex;
      host.style.borderRadius = style.borderRadius;
      host.style.opacity = style.opacity;
      canvas.style.objectFit = style.objectFit;
      canvas.style.objectPosition = style.objectPosition;
    };

    function capture(mediaTime) {
      if (active !== state || !state.ready || !state.eligible || state.video.seeking || state.lastCapturedTime === mediaTime) return;
      // Source replacement can invalidate decoder state between rVFC and a paused-frame capture.
      if (state.video.readyState < 2 || !core.dimensions(state.video.videoWidth, state.video.videoHeight)) return;
      // Keep only the latest decoded frame while the GPU completes its current work.
      discardPendingGpu(state);
      const request = { mediaTime, capturedAt: performance.now(), generation: state.generation };
      try {
        request.input = new VideoFrame(state.video, { timestamp: Math.round(mediaTime * 1000000) });
        request.captureMs = performance.now() - request.capturedAt;
        request.inputWidth = request.input.displayWidth;
        request.inputHeight = request.input.displayHeight;
      } catch (error) {
        if (error?.name === "InvalidStateError") {
          invalidate();
          status("waiting", "Ожидание первого кадра нового видео.");
        } else stop(true, captureError(error));
        return;
      }
      state.lastCapturedTime = mediaTime;
      if (state.gpuBusy) {
        state.pendingGpu = request;
        updateGpuQueue(state);
      } else renderGpu(request);
    }
    async function renderGpu(request) {
      state.gpuBusy = true;
      updateGpuQueue(state);
      try {
        const renderStarted = performance.now();
        const result = await state.gpu.render(request.input);
        const completedAt = performance.now();
        if (active !== state) return;
        state.update();
        if (active !== state) return;
        state.completed++;
        state.latencyMs = completedAt - request.capturedAt;
        state.diagnostics = {
          ...state.gpuInfo,
          inputWidth: request.inputWidth, inputHeight: request.inputHeight,
          outputWidth: result?.width, outputHeight: result?.height,
          timings: {
            captureMs: request.captureMs,
            queueWaitMs: Math.max(0, renderStarted - request.capturedAt - request.captureMs),
            renderMs: completedAt - renderStarted,
            submitMs: result?.submitMs, validationWaitMs: result?.validationWaitMs,
            completionWaitMs: result?.completionWaitMs, totalMs: state.latencyMs,
          },
        };
        host.dataset.upscaleLatency = String(state.latencyMs);
        if (request.generation !== state.generation || !state.eligible || !core.fresh(request, current())) {
          state.dropped++;
          hide();
          if (request.generation === state.generation && state.eligible) {
            status("waiting", `Кадр опоздал: ${state.latencyMs.toFixed(0)} мс с захвата до готовности. Показывается исходное видео. Попробуйте более лёгкую модель; на паузе можно сравнить качество.`);
          }
          return;
        }
        state.displayed = request;
        state.shown++;
        host.dataset.upscaleFrames = String((Number(host.dataset.upscaleFrames) || 0) + 1);
        host.dataset.upscaleMediaTime = String(request.mediaTime);
        host.style.visibility = "visible"; state.visible = true;
        status(state.video.paused ? "paused" : "playing", state.video.paused
          ? "Кадр обработан на GPU браузера. Управление остаётся у плеера сайта."
          : "Апскейлинг на GPU браузера.");
      } catch (error) {
        if (active === state) stop(true, error?.name === "SecurityError" ? captureError(error) : `Ошибка WebGPU: ${error?.message || error}`);
      } finally {
        request.input.close();
        state.gpuBusy = false;
        if (active !== state) {
          updateGpuQueue(state);
          state.gpu?.free(); state.gpu = undefined;
        } else {
          const pending = state.pendingGpu;
          if (pending && pending.generation === state.generation && state.eligible && !state.video.seeking && core.fresh(pending, current())) {
            state.pendingGpu = undefined;
            renderGpu(pending);
          } else discardPendingGpu(state);
        }
      }
    }
    function scheduleFrame() {
      if (active !== state || state.callback !== undefined || !state.video.requestVideoFrameCallback) return;
      state.callback = state.video.requestVideoFrameCallback((_, metadata) => {
        state.callback = undefined;
        state.update();
        if (metadata.mediaTime !== state.lastObservedTime) {
          const difference = metadata.presentedFrames - state.lastPresentedFrames;
          state.sourceFrames += Number.isFinite(difference) && difference > 0 ? difference : 1;
          state.lastObservedTime = metadata.mediaTime;
          state.lastPresentedFrames = metadata.presentedFrames;
        }
        capture(metadata.mediaTime);
        scheduleFrame();
      });
    }
    function attachVideo(target) {
      const previous = state.video;
      if (state.callback !== undefined) previous.cancelVideoFrameCallback?.(state.callback);
      state.callback = undefined;
      state.resize.unobserve(previous);
      for (const entry of state.listeners.filter(([item]) => item === previous)) {
        entry[0].removeEventListener(entry[1], entry[2], entry[3]);
      }
      state.listeners = state.listeners.filter(([item]) => item !== previous);
      state.video = target;
      invalidate();
      target.after(host);
      for (const type of ["seeking", "seeked", "loadstart", "emptied", "ratechange", "pause", "play", "resize"]) listen(target, type, invalidate);
      listen(target, "encrypted", () => stop(true, "Видео защищено DRM. Захват кадров недоступен."));
      for (const type of ["pointerenter", "pointerleave", "focus", "blur", "enterpictureinpicture", "leavepictureinpicture"]) listen(target, type, state.update);
      state.resize.observe(target);
      scheduleFrame();
    }
    function animate() {
      if (active !== state) return;
      try {
        if (!state.eligible) hide();
        else if (state.displayed && !core.displayFresh(state.displayed, current())) {
          hide(); status("waiting", "Обработка задерживается. Пока показывается исходное видео.");
        }
      } catch (error) { stop(true, captureError(error)); return; }
      // rVFC stops on pause; process one still frame after seeking or pausing as well.
      if (state.video.paused || !state.video.requestVideoFrameCallback) capture(state.video.currentTime);
      state.animation = requestAnimationFrame(animate);
    }
    state.resize = new ResizeObserver(state.update);
    attachVideo(video);
    listen(window, "resize", state.update);
    listen(window, "scroll", state.update, true);
    listen(document, "fullscreenchange", state.update);
    listen(document, "visibilitychange", () => { invalidate(); state.update(); });
    state.timer = setInterval(state.update, 250);
    state.update();
    state.animation = requestAnimationFrame(animate);
    status("preparing", "Загрузка модели и подготовка GPU браузера…", true);
    import(chrome.runtime.getURL("features/video-upscale/webgpu-client.mjs"))
      .then((module) => active === state ? module.createWebGpu(canvas, message.model, video.videoWidth, video.videoHeight) : null)
      .then((gpu) => {
        if (!gpu) return;
        if (active !== state) { gpu.destroy(); gpu.free(); return; }
        state.gpu = gpu;
        state.gpuInfo = gpu.info;
        state.diagnostics = { ...state.gpuInfo };
        host.dataset.upscaleAdapter = JSON.stringify(state.gpuInfo);
        status("preparing", "GPU готов. Ожидание первого обработанного кадра…", true);
        state.ready = true;
        state.update();
        capture(state.video.currentTime);
      }).catch((error) => {
        if (active === state) stop(true, `WebGPU не запущен: ${error?.message || error}`);
      });
    return { started: true, source: selected.source, time: selected.time, properties: selected.properties, wasPlaying: !video.paused };
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "video-upscale:content" || sender.id !== chrome.runtime.id) return;
    if (message.action === "start") {
      start(message).then(reply, (error) => { stop(); reply({ error: error.message }); });
      return true;
    }
    if (message.id !== active?.id) { reply({ active: false }); return; }
    if (message.action === "stop") { stop(); reply({ stopped: true }); }
    else if (message.action === "probe") reply({ active: true });
  });
  window.addEventListener("pagehide", () => stop(true));
  globalThis[key] = { list };
  return list();
})();
