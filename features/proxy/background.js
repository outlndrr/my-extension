const defaults = { scheme: "http", host: "", port: 8080, username: "", password: "" };

function normalizeSettings(input) {
  if (!input || !["http", "socks5"].includes(input.scheme)) {
    throw new Error("Выберите HTTP или SOCKS5.");
  }
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!host || /[\s/@?#\\]/.test(host) ||
      (host.startsWith("[") ? !host.endsWith("]") : host.includes(":"))) {
    throw new Error("Укажите адрес без протокола, порта и пути. IPv6 — в квадратных скобках.");
  }
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new Error("Некорректный адрес прокси.");
  }
  const port = Number(input.port);
  if (!/^[0-9]+$/.test(String(input.port)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Порт должен быть целым числом от 1 до 65535.");
  }
  const { username, password } = input;
  if (typeof username !== "string" || typeof password !== "string") {
    throw new Error("Некорректные данные авторизации.");
  }
  if (input.scheme === "socks5" && (username || password)) {
    throw new Error("Chromium не поддерживает логин и пароль для SOCKS5. Очистите оба поля или выберите HTTP.");
  }
  if (password && !username) throw new Error("Укажите логин или очистите пароль.");
  return { scheme: input.scheme, host: hostname, port, username, password };
}

async function getState() {
  const [saved, effective] = await Promise.all([
    chrome.storage.local.get({ browserProxy: defaults }),
    chrome.proxy.settings.get({ incognito: false }),
  ]);
  return { settings: saved.browserProxy, control: effective.levelOfControl };
}

async function handleCommand(message) {
  if (message.type === "proxy:get") return getState();
  if (message.type === "proxy:disable") {
    await chrome.proxy.settings.clear({ scope: "regular" });
    return getState();
  }
  if (message.type !== "proxy:apply") throw new Error("Неизвестная команда.");
  const settings = normalizeSettings(message.settings);
  const before = await getState();
  if (!["controllable_by_this_extension", "controlled_by_this_extension"].includes(before.control)) {
    throw new Error("Прокси управляется политикой браузера или другим расширением.");
  }
  // Credentials must be available before the first proxy authentication challenge.
  await chrome.storage.local.set({ browserProxy: settings });
  try {
    await chrome.proxy.settings.set({
      scope: "regular",
      value: {
        mode: "fixed_servers",
        rules: { singleProxy: { scheme: settings.scheme, host: settings.host, port: settings.port } },
      },
    });
  } catch (error) {
    await chrome.storage.local.set({ browserProxy: before.settings });
    throw error;
  }
  return getState();
}

let commands = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("settings/index.html")) {
    return false;
  }
  commands = commands.then(() => handleCommand(message));
  commands.then((state) => respond({ ok: true, ...state }),
    (error) => respond({ ok: false, error: error.message }));
  commands = commands.catch(() => {});
  return true;
});

function canonicalHost(host) {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

async function authenticate(details) {
  if (!details.isProxy) return {};
  const [saved, effective] = await Promise.all([
    chrome.storage.local.get({ browserProxy: defaults }),
    chrome.proxy.settings.get({ incognito: details.incognito === true }),
  ]);
  const settings = saved.browserProxy;
  if (settings.scheme !== "http" || !settings.username) return {};
  const server = effective.value.rules?.singleProxy;
  if (effective.levelOfControl !== "controlled_by_this_extension" ||
      effective.value.mode !== "fixed_servers" || server?.scheme !== "http" ||
      canonicalHost(server.host) !== canonicalHost(settings.host) || server.port !== settings.port ||
      canonicalHost(details.challenger.host) !== canonicalHost(settings.host) ||
      details.challenger.port !== settings.port) return {};

  // Session storage survives worker suspension, so rejected credentials are not retried forever.
  const key = `proxyAuth:${details.requestId}`;
  const attempted = await chrome.storage.session.get(key);
  if (attempted[key]) return { cancel: true };
  await chrome.storage.session.set({ [key]: true });
  return { authCredentials: { username: settings.username, password: settings.password } };
}

chrome.webRequest.onAuthRequired.addListener((details, respond) => {
  authenticate(details).then(respond, () => respond(details.isProxy ? { cancel: true } : {}));
}, { urls: ["<all_urls>"] }, ["asyncBlocking"]);

function clearAttempt(details) {
  chrome.storage.session.remove(`proxyAuth:${details.requestId}`).catch(() => {});
}
chrome.webRequest.onCompleted.addListener(clearAttempt, { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(clearAttempt, { urls: ["<all_urls>"] });
