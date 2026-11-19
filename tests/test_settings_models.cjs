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

test("MinerU settings render and collect correctly", async () => {
  const PR = {
    t: (k) => k,
    esc: (v) => String(v ?? ""),
    icon: () => "",
    opt: (items, selected) => items.map(([v, l]) => `<option value="${v}"${String(v) === String(selected) ? " selected" : ""}>${l}</option>`).join(""),
    settingsTabs: {},
    $: () => ({ addEventListener() {} }),
  };
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} } };
  for (const name of ["settings.js", "settings-models.js", "settings-chat.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/" + name), "utf8"), context);
  }
  const s = {
    cfg: {
      engine: "openai", batch_pages: 2, concurrency: 0, page_cap: 60, auto_translate: true,
      claude: {}, codex: {}, openai: {},
      mineru: { enabled: true, mode: "local", token: "••••1234", base_url: "http://127.0.0.1:8000", model_version: "pipeline" },
    },
    chat: { models: [{ id: "m1", name: "gpt-4o", engine: "openai", model: "gpt-4o" }], default: "m1" },
    presets: [], found: {}, models: {},
  };
  const html = PR.settingsTabs.chat.render(s);
  assert.ok(!html.includes('data-k="local_references"'));
  assert.ok(!html.includes('data-k="mineru.model_version"'));
  assert.ok(html.includes('data-k="mineru.enabled"'));
  assert.ok(html.includes('data-k="mineru.base_url"'));
  assert.ok(html.includes('id="mineruHelpBtn"'));
  assert.ok(html.includes('id="mineruTestBtn"'));
  assert.ok(html.includes('id="mineruParseTestBtn"'));
  const collected = PR.settingsTabs.engine.collect(s);
  assert.equal("local_references" in collected, false);
  assert.deepEqual(JSON.parse(JSON.stringify(collected.mineru)), {
    enabled: true,
    mode: "local",
    token: "••••1234",
    base_url: "http://127.0.0.1:8000",
    model_version: "vlm",
  });
  s.cfg.mineru.enabled = false;
  const disabledHtml = PR.settingsTabs.chat.render(s);
  assert.ok(disabledHtml.includes('id="mineruHelpBtn"'));

  const modalNode = {
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener() {},
    querySelector: () => ({ innerHTML: "" }),
  };
  let guideBody = null;
  context.document.getElementById = () => null;
  context.document.createElement = () => ({
    ...modalNode,
    querySelector: () => (guideBody = { innerHTML: "" }),
  });
  context.document.body = { appendChild() {} };
  context.requestAnimationFrame = (fn) => fn();
  await PR.settingsTabs.chat.click({ target: { closest: (sel) => sel === "#mineruHelpBtn" } }, s);
  assert.ok(guideBody && guideBody.innerHTML.includes("https://mineru.net"));
  assert.ok(guideBody.innerHTML.includes("https://github.com/opendatalab/mineru"));
  assert.ok(guideBody.innerHTML.includes('<div class="mg-img-wrap"><img src="/web/img/mineru-showcase.jpg"'));
  assert.ok(guideBody.innerHTML.includes('<div class="mg-img-wrap"><img src="/web/img/mineru-api-token.png"'));
  assert.ok(!guideBody.innerHTML.includes('<a class="mg-img-wrap"'));
  assert.ok(!guideBody.innerHTML.includes("免架設，附圖"));
  assert.ok(guideBody.innerHTML.includes("方式一：註冊並取得 MinerU Cloud API Token（免架設）"));
  assert.ok(guideBody.innerHTML.includes("第三方雲端伺服器（位於中國大陸）"));
  assert.ok(guideBody.innerHTML.includes("省去檔案上傳與 API 等待時間"));
  assert.ok(!html.includes("mineru-mode-notes"));
  assert.ok(guideBody.innerHTML.includes('id="mineruAgentCopyBtn"'));
  assert.ok(guideBody.innerHTML.includes("npx skills add opendatalab/MinerU --skill mineru --global --yes"));
});
