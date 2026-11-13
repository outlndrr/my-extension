const toggles = [...document.querySelectorAll("input[data-setting]")];
const featureStatus = document.getElementById("feature-status");
const defaults = Object.fromEntries(toggles.map((toggle) => [toggle.dataset.setting, true]));

function showFeatureStatus(message, error = false) {
  featureStatus.textContent = message;
  featureStatus.toggleAttribute("data-error", error);
}

chrome.storage.local.get(defaults).then((settings) => {
  for (const toggle of toggles) {
    toggle.checked = settings[toggle.dataset.setting] !== false;
    toggle.disabled = false;
  }
  showFeatureStatus("Изменения сохраняются сразу.");
}).catch(() => {
  showFeatureStatus("Не удалось загрузить настройки. Откройте настройки ещё раз.", true);
});

for (const toggle of toggles) {
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      await chrome.storage.local.set({ [toggle.dataset.setting]: toggle.checked });
      showFeatureStatus(toggle.checked ? "Функция включена." : "Функция выключена.");
    } catch {
      toggle.checked = !toggle.checked;
      showFeatureStatus("Не удалось сохранить настройку. Попробуйте ещё раз.", true);
    } finally {
      toggle.disabled = false;
    }
  });
}
