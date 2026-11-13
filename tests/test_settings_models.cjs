const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("API model names and recommendation tags render in Traditional Chinese", () => {
  const dict = JSON.parse(fs.readFileSync(path.join(__dirname, "../easyread/web/i18n/zh-TW.json"), "utf8"));
  const PR = {
    t: (key, vars = {}) => (dict[key] || key).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m),
    esc: value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    opt: (items, selected) => items.map(([value, label]) => '<option value="' + value + '"' + (value === selected ? " selected" : "") + ">" + label + "</option>").join(""),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/settings-api.js"), "utf8"), { window: { PR } });
  const s = {
    presets: [{ id: "deepseek", name: "DeepSeek", base_url: "https://example.test/v1", models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tag: "更强，不能看图" },
    ] }],
    api_choices: ["deepseek"], cfg: { openai: { saved_keys: [] } }, chatKeys: {}, found: {},
  };
  const a = { preset: "deepseek", base_url: "https://example.test/v1", api: "chat", model: "deepseek-v4-pro", key: "" };
  const html = PR.apiForm.html(s, a, { keyProp: "key", vision: false });
  assert.ok(html.includes("DeepSeek V4 Pro · 能力較強、不支援圖片"));
  assert.ok(!html.includes("更强，不能看图"));
});

test("Codex settings render supported effort levels and save the chosen overrides", () => {
  const PR = { t: (x) => x, esc: String, settingsTabs: {},
    $: () => ({ addEventListener() {} }) };
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} } };
  for (const name of ["settings.js", "settings-models.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/" + name), "utf8"), context);
  }
  const s = { cfg: { codex: { model: "example", reasoning_effort: "low", service_tier: "fast" }, claude: {}, openai: {} },
    models: { codex: { configured_reasoning: "high", models: [{ id: "example", reasoning_levels: ["low", "high"] }] } } };
  const f = { kind: "codex", ...s.cfg.codex };
  const html = PR.modelReasoningFields(s, f);
  assert.match(html, /value="low" selected/);
  assert.match(html, /value="fast" selected/);
  assert.doesNotMatch(html, /value="max"/);
  const saved = PR.settingsTabs.engine.collect(s).codex;
  assert.equal(saved.reasoning_effort, "low");
  assert.equal(saved.service_tier, "fast");
  s.models.codex.models = [];
  assert.match(PR.modelReasoningFields(s, f), /value="low" selected/);
  assert.match(PR.modelReasoningFields(s, { kind: "claude", model: "opus", reasoning_effort: "max" }), /value="max" selected/);
  assert.doesNotMatch(PR.modelReasoningFields(s, { kind: "claude", model: "haiku" }), /value="low"/);
  assert.match(PR.modelReasoningFields(s, { kind: "api", model: "custom", reasoning_effort: "medium" }), /value="medium" selected/);
});
