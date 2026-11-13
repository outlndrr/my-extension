const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync("features/proxy/settings.js", "utf8");
const saved = { scheme: "http", host: "proxy.example.com", port: 8080, username: "user", password: "secret" };
const tick = () => new Promise(setImmediate);

async function setup({ loadFails = false } = {}) {
  const elements = Object.fromEntries([
    "proxy-form", "fields", "status", "scheme", "host", "port", "username", "password", "disable",
  ].map((id) => [id, {
    value: "", disabled: true, textContent: "", dataset: {},
    addEventListener(event, callback) { this[event] = callback; },
  }]));
  const messages = [];
  const app = { elements, messages, fail: false };
  vm.runInNewContext(source, {
    document: { getElementById: (id) => elements[id] },
    chrome: { runtime: { async sendMessage(message) {
      messages.push(message);
      if (loadFails) throw new Error("Offline");
      if (app.fail) return { ok: false, error: "Ошибка прокси" };
      return { ok: true, settings: saved, control: message.type === "proxy:apply"
        ? "controlled_by_this_extension" : "controllable_by_this_extension" };
    } } },
  });
  await tick();
  return app;
}

test("settings page loads values, applies the form and disables without validating it", async () => {
  const { elements: el, messages } = await setup();
  assert.equal(el.fields.disabled, false);
  assert.equal(el.password.value, "secret");
  let prevented = false;
  el["proxy-form"].submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(el.fields.disabled, true);
  await tick();
  assert.equal(el.fields.disabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[1])), { type: "proxy:apply", settings: saved });
  assert.match(el.status.textContent, /включён/);
  el.host.value = "";
  el.disable.click();
  await tick();
  assert.equal(messages[2].type, "proxy:disable");
  assert.match(el.status.textContent, /отключён/);
});

test("failed apply keeps entered data and re-enables controls for recovery", async () => {
  const app = await setup();
  app.fail = true;
  app.elements.disable.click();
  await tick();
  assert.equal(app.elements.fields.disabled, false);
  assert.equal(app.elements.status.dataset.tone, "error");
  assert.equal(app.elements.status.textContent, "Ошибка прокси");
  assert.equal(app.elements.password.value, "secret");
});

test("failed initial load cannot apply an empty form", async () => {
  const { elements } = await setup({ loadFails: true });
  assert.equal(elements.fields.disabled, true);
  assert.equal(elements.status.dataset.tone, "error");
});
