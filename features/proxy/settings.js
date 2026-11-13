const form = document.getElementById("proxy-form");
const fields = document.getElementById("fields");
const status = document.getElementById("status");
const names = ["scheme", "host", "port", "username", "password"];
const inputs = Object.fromEntries(names.map((name) => [name, document.getElementById(name)]));

function showStatus(message, tone) {
  status.textContent = message;
  status.dataset.tone = tone;
}

async function command(type, settings) {
  const result = await chrome.runtime.sendMessage({ type, settings });
  if (!result?.ok) throw new Error(result?.error || "Фоновый процесс недоступен.");
  return result;
}

function showControl(control) {
  if (control === "controlled_by_this_extension") {
    showStatus("Прокси включён этим расширением. Доступность сервера не проверялась.", "ok");
  } else if (control === "controllable_by_this_extension") {
    showStatus("Прокси расширения отключён. Действуют настройки браузера или системы.", "off");
  } else {
    showStatus("Прокси управляется политикой браузера или другим расширением.", "error");
  }
}

command("proxy:get").then(({ settings, control }) => {
  for (const name of names) inputs[name].value = settings[name];
  fields.disabled = false;
  showControl(control);
}).catch(() => {
  showStatus("Не удалось загрузить настройки. Откройте страницу ещё раз.", "error");
});

async function changeProxy(type) {
  const settings = Object.fromEntries(names.map((name) => [name, inputs[name].value]));
  fields.disabled = true;
  try {
    const result = await command(type, settings);
    showControl(result.control);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    fields.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  changeProxy("proxy:apply");
});
document.getElementById("disable").addEventListener("click", () => changeProxy("proxy:disable"));
