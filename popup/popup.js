const proxyStatus = document.getElementById("proxy-status");
const proxyDetail = document.getElementById("proxy-detail");

function showProxy(message, detail, tone) {
  proxyStatus.textContent = message;
  proxyStatus.dataset.tone = tone;
  proxyDetail.textContent = detail;
}

function proxyEnabled(effective) {
  return effective.levelOfControl === "controlled_by_this_extension" &&
    effective.value.mode === "fixed_servers" && Boolean(effective.value.rules?.singleProxy);
}

function showInactiveProxy(effective) {
  if (["not_controllable", "controlled_by_other_extensions"].includes(effective.levelOfControl)) {
    showProxy("Управляется вне расширения", "Прокси задан браузером или другим расширением. Соединение не проверялось.", "warn");
  } else {
    showProxy("Отключён в расширении", "Действуют настройки браузера или системы.", "off");
  }
}

async function loadProxy() {
  let before;
  try {
    before = await chrome.proxy.settings.get({ incognito: false });
  } catch {
    showProxy("Состояние неизвестно", "Не удалось прочитать настройки прокси. Откройте меню ещё раз.", "error");
    return;
  }
  if (!proxyEnabled(before)) {
    showInactiveProxy(before);
    return;
  }
  showProxy("Проверка соединения…", "Один HTTPS-запрос к example.com. Ожидание до 8 секунд.", "pending");
  let connected = false;
  try {
    const response = await fetch("https://example.com/", {
      method: "HEAD", cache: "no-store", credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000),
    });
    connected = response.ok;
  } catch {
    // A failed probe can mean an unavailable proxy, Internet connection, or test site.
  }
  let after;
  try {
    after = await chrome.proxy.settings.get({ incognito: false });
  } catch {
    showProxy("Состояние неизвестно", "Не удалось подтвердить настройки после проверки.", "error");
    return;
  }
  if (!proxyEnabled(after)) {
    showInactiveProxy(after);
  } else if (JSON.stringify(before.value) !== JSON.stringify(after.value)) {
    showProxy("Настройки изменились", "Откройте меню ещё раз для проверки нового прокси.", "warn");
  } else if (connected) {
    showProxy("Соединение работает", "example.com доступен через включённый прокси. Это не проверка анонимности.", "ok");
  } else {
    showProxy("Соединение не подтверждено", "Прокси включён. Причина может быть в нём, сети или example.com.", "error");
  }
}

loadProxy();
