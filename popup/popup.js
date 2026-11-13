const proxyStatus = document.getElementById("proxy-status");
const proxyServer = document.getElementById("proxy-server");
const proxyAddress = document.getElementById("proxy-address");
const proxyMeta = document.getElementById("proxy-meta");
const proxyDetail = document.getElementById("proxy-detail");
const copyProxy = document.getElementById("copy-proxy");
const copyStatus = document.getElementById("copy-status");
const featureCount = document.getElementById("feature-count");
const featureNames = {
  youtubeTheaterEnabled: "Театральный режим YouTube",
  youtubeFullChatEnabled: "Обычный чат YouTube",
  pageVisibilityEnabled: "Disable Page Visibility",
};
const featureDefaults = Object.fromEntries(Object.keys(featureNames).map((key) => [key, true]));
let proxyReadId = 0;
let featureReadId = 0;

function showProxy(message, detail, tone) {
  proxyStatus.textContent = message;
  proxyStatus.dataset.tone = tone;
  proxyStatus.title = detail;
  proxyServer.hidden = true;
  proxyAddress.textContent = "";
  proxyMeta.textContent = "";
  copyProxy.disabled = true;
  copyStatus.textContent = "";
  proxyDetail.textContent = detail;
  proxyDetail.hidden = false;
  proxyDetail.dataset.tone = tone;
}

function proxyEnabled(effective) {
  return effective.levelOfControl === "controlled_by_this_extension" &&
    effective.value.mode === "fixed_servers" && Boolean(effective.value.rules?.singleProxy);
}

function showInactiveProxy(effective) {
  if (["not_controllable", "controlled_by_other_extensions"].includes(effective.levelOfControl)) {
    showProxy("Внешнее управление", "Настройки прокси заданы браузером или другим расширением.", "warn");
  } else {
    showProxy("Отключено", "Действуют настройки браузера или системы.", "off");
  }
}

async function loadProxy() {
  const readId = ++proxyReadId;
  try {
    const effective = await chrome.proxy.settings.get({ incognito: false });
    if (readId !== proxyReadId) return;
    if (!proxyEnabled(effective)) {
      showInactiveProxy(effective);
      return;
    }
    const server = effective.value.rules.singleProxy;
    const host = server.host.includes(":") && !server.host.startsWith("[")
      ? `[${server.host}]` : server.host;
    const address = `${host}:${server.port}`;
    const scheme = server.scheme.toUpperCase();
    showProxy("Подключено", "Прокси включён в браузере.", "ok");
    proxyAddress.textContent = address;
    proxyMeta.textContent = scheme;
    proxyServer.hidden = false;
    proxyDetail.hidden = true;
    copyProxy.disabled = false;
  } catch {
    if (readId !== proxyReadId) return;
    showProxy("Неизвестно", "Не удалось прочитать настройки прокси. Откройте меню ещё раз.", "error");
  }
}

copyProxy.addEventListener("click", async () => {
  if (copyProxy.disabled || proxyServer.hidden) return;
  const readId = proxyReadId;
  const address = proxyAddress.textContent;
  copyProxy.disabled = true;
  copyStatus.textContent = "";
  try {
    await navigator.clipboard.writeText(address);
    if (readId !== proxyReadId) return;
    copyStatus.textContent = "Адрес скопирован";
    copyStatus.dataset.tone = "ok";
  } catch {
    if (readId !== proxyReadId) return;
    copyStatus.textContent = "Не удалось скопировать. Выделите адрес и скопируйте вручную.";
    copyStatus.dataset.tone = "error";
  } finally {
    if (readId === proxyReadId) copyProxy.disabled = false;
  }
});

async function loadFeatures() {
  const readId = ++featureReadId;
  try {
    const settings = await chrome.storage.local.get(featureDefaults);
    if (readId !== featureReadId) return;
    const enabled = Object.keys(featureNames).filter((key) => settings[key] !== false);
    featureCount.textContent = `${enabled.length} из ${Object.keys(featureNames).length}`;
    featureCount.title = enabled.length ? enabled.map((key) => featureNames[key]).join(", ") : "Все функции отключены";
    featureCount.dataset.tone = enabled.length ? "ok" : "off";
  } catch {
    if (readId !== featureReadId) return;
    featureCount.textContent = "Недоступно";
    featureCount.title = "Не удалось прочитать настройки функций.";
    featureCount.dataset.tone = "error";
  }
}

chrome.proxy.settings.onChange.addListener(loadProxy);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(featureNames).some((key) => Object.hasOwn(changes, key))) loadFeatures();
});
loadProxy();
loadFeatures();
