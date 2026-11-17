let wasmReady;

async function runtime() {
  wasmReady ||= import("./wasm/pkg/upscale_wasm.js").then(async (module) => {
    await module.default({ module_or_path: new URL("./wasm/pkg/upscale_wasm_bg.wasm", import.meta.url) });
    return module;
  }).catch((error) => { wasmReady = undefined; throw error; });
  return wasmReady;
}

export async function createWebGpu(canvas, modelId, width, height) {
  if (!globalThis.isSecureContext || !navigator.gpu) {
    throw new Error("WebGPU недоступен. Откройте HTTPS-страницу в Chrome/Edge с включённым аппаратным ускорением.");
  }
  if (typeof VideoFrame !== "function") throw new Error("Браузер не поддерживает VideoFrame. Обновите Chrome/Edge.");
  const catalogueResponse = await fetch(new URL("./webgpu-models/catalogue.json", import.meta.url));
  if (!catalogueResponse.ok) throw new Error("В расширении отсутствует каталог моделей WebGPU.");
  const catalogue = await catalogueResponse.json();
  const model = catalogue.find((item) => item.id === modelId);
  if (!model || !/^[a-z0-9-]+\.bin$/.test(model.file)) throw new Error("Неизвестная модель WebGPU.");
  const [module, response] = await Promise.all([
    runtime(), fetch(new URL(`./webgpu-models/${model.file}`, import.meta.url)),
  ]);
  if (!response.ok) throw new Error("Не удалось загрузить встроенную модель WebGPU.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  if (bytes.byteLength !== model.bytes || hash !== model.sha256) throw new Error("Файл модели WebGPU повреждён. Обновите расширение.");
  return module.GpuUpscaler.create(canvas, bytes, width, height);
}
