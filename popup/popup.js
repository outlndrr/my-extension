const proxyStatus = document.getElementById("proxy-status");
let proxyReadId = 0;

function showProxy(message, detail, tone) {
  proxyStatus.textContent = message;
  proxyStatus.dataset.tone = tone;
  proxyStatus.title = detail;
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
    if (proxyEnabled(effective)) showProxy("Подключено", "Прокси включён в браузере.", "ok");
    else showInactiveProxy(effective);
  } catch {
    if (readId !== proxyReadId) return;
    showProxy("Неизвестно", "Не удалось прочитать настройки прокси. Откройте меню ещё раз.", "error");
  }
}

chrome.proxy.settings.onChange.addListener(loadProxy);
loadProxy();
