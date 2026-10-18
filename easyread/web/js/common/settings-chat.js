/* 设置 → 模型：翻译和“问 AI”合在一页。
   上面一排卡片是你能用的模型（Claude Code / Codex / 各家 API），每张卡片可以标“翻译”和“问 AI 默认”；
   点卡片弹出菜单：设为翻译、设为问 AI、改 Key 和地址（只有 API 卡片）、删除；拖动卡片排序。添加时下面出现来源卡片和模型选择，API 的表单见 settings-api.js。
   下面是翻译自己的设置（每批几页、同时译几段、导入后自动翻译、试译一句）。
   存的时候：翻译用的那张卡片写进 config 的 engine / claude / codex / openai（后台翻译读这些），整份名单写进 chat.models。
   API 的 Key 每家只存一份，翻译和问 AI 共用。 */
(function (PR) {
  "use strict";
  const T = PR.settingsTabs;
  const kindOf = (m) => (m.engine === "openai" ? "api" : m.engine);
  const isApi = (k) => k === "api";
  const root = () => PR.$("#settingsDlg");
  const preset = (s, id) => s.presets.find((x) => x.id === id);

  /* ---------- 翻译用的是哪张卡片 ---------- */
  function sameAsTranslation(s, m) {
    const c = s.cfg, e = c.engine;
    if (m.engine !== e) return false;
    if (["reasoning_effort", "service_tier"].some((k) => (m[k] || "") !== (c[e][k] || ""))) return false;
    if (e === "claude" || e === "codex") return (m.model || "") === (c[e].model || "");
    const o = c.openai, p = preset(s, m.preset);
    return (m.preset || "") === (o.preset || "") && (m.model || "") === (o.model || "") &&
      (m.base_url || (p ? p.base_url : "")) === (o.base_url || "");
  }
  const transIndex = (s) => s.chat.models.findIndex((m) => sameAsTranslation(s, m));

  /* 以前的“跟随默认”卡片（模型空着）钉到具体模型；钉完和别的卡片一样的就合成一张 */
  function pinDefaults(s) {
    if (s.pinned || !s.models || !s.chat) return;
    s.pinned = true;
    const c = s.cfg;
    if (c.engine === "claude" || c.engine === "codex") c[c.engine].model = PR.cliPin(s, c.engine, c[c.engine].model);
    const list = s.chat.models, seen = {};
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.engine === "claude" || m.engine === "codex") {
        const was = m.model || "";
        m.model = PR.cliPin(s, m.engine, was);
        if (!was && m.model) { const n = autoName(s, { kind: m.engine, model: m.model }); m.name = m.label = n; m.detail = m.model; }
      }
      const key = [m.engine, m.model, m.preset || "", m.base_url || "", m.reasoning_effort || "", m.service_tier || ""].join("|");
      if (seen[key]) {
        if (s.chat.default === m.id) s.chat.default = seen[key].id;
        list.splice(i--, 1);
      } else seen[key] = m;
    }
  }

  /* 翻译现在用的模型不在名单里（以前分两页设的）：给它补一张卡片 */
  function ensureTranslationCard(s) {
    if (s.transChecked || !s.chat) return;
    s.transChecked = true;
    if (s.cfg.engine === "none") {
      if (s.cfg.review_policy) return;  // Keep the explicit saved selection in review mode.
      s.cfg.engine = "claude"; s.cfg.auto_translate = false;
    }  // 旧的“不翻译”= 关掉自动翻译
    if (transIndex(s) >= 0) return;
    const c = s.cfg, e = c.engine, o = c.openai, p = preset(s, o.preset);
    const f = e === "openai" ? { kind: "api", preset: o.preset || "", model: o.model || "", base_url: o.base_url || "", api: o.api || "chat" }
      : { kind: e, model: c[e].model || "" };
    Object.assign(f, { reasoning_effort: c[e].reasoning_effort || "", service_tier: c[e].service_tier || "" });
    s.chat.models.unshift(Object.assign(toModel(s, f, p), { id: "m" + Date.now().toString(36) }));
  }

  /* 把一张卡片设成翻译用：写进 cfg 的 engine 和对应那一节 */
  function useForTranslation(s, m) {
    const c = s.cfg;
    if (m.engine === "openai") {
      const p = preset(s, m.preset), typed = (s.chatKeys || {})[m.preset];
      const rec = ((p && p.models) || []).find((x) => x.id === m.model);
      Object.assign(c.openai, { preset: m.preset || "", base_url: m.base_url || (p ? p.base_url : ""), api: m.api || (p && p.api) || "chat",
        model: m.model, api_key: typed || (PR.apiHasKey(s, m.preset) ? "••••" : ""), vision: rec ? !!rec.vision : !!c.openai.vision });
    } else {
      if (m.engine === "codex" && c.codex.model !== (m.model || "")) c.codex.reasoning_effort = "";
      c[m.engine].model = m.model || "";
    }
    c.engine = m.engine;
    c[m.engine].reasoning_effort = m.reasoning_effort || "";
    c[m.engine].service_tier = m.service_tier || "";
  }

  /* ---------- 卡片 ---------- */
  function cardsHtml(s) {
    const list = s.chat.models, ti = transIndex(s);
    return '<div class="engine-cards mc-cards">' + list.map((m, i) => {
      const def = s.chat.default === m.id, tr = i === ti;
      const tags = (tr ? '<span class="badge ok">' + PR.t("翻译") + "</span>" : "") + (def ? '<span class="badge ok">' + PR.t("问 AI 默认") + "</span>" : "");
      const bad = m.ready === false ? '<span class="badge bad" title="' + PR.esc(m.hint || "") + '">' + PR.esc(m.hint || PR.t("还不能用")) + "</span>" : "";
      return '<div class="mc' + (tr || def ? " on" : "") + (s.editing === m.id ? " editing" : "") + (m.ready === false ? " off" : "") + '" data-cm="more" data-i="' + i + '" draggable="true" role="button" tabindex="0" title="' + PR.t("点一下设置，拖动排序") + '">' +
        '<span class="mc-more">' + PR.icon("more", "sm") + "</span>" +
        "<b>" + PR.esc(m.label || m.name) + "</b>" + PR.esc(m.source || "") +
        (tags || bad ? '<span class="mc-tags">' + tags + bad + "</span>" : "") + "</div>";
    }).join("") +
      '<div class="mc add' + (s.editing === "new" ? " editing" : "") + '" data-cm="add" role="button" tabindex="0">' + PR.icon("plus") + "<b>" + PR.t("添加模型") + "</b></div></div>";
  }

  /* ---------- 添加 / 修改的表单 ---------- */
  function formHtml(s) {
    const f = s.form;
    const card = (k, title) => '<button data-cmk="' + k + '" class="' + (f.kind === k ? "on" : "") + '"><b>' + title + "</b></button>";
    let h = '<div class="mc-form"><h4 class="set-h">' + (s.editing === "new" ? PR.t("添加模型") : PR.t("修改")) + "</h4>" +
      '<div class="engine-cards small">' + card("claude", "Claude Code") + card("codex", "Codex CLI") + card("api", PR.t("API 接口")) + "</div>";
    if (f.kind === "claude" || f.kind === "codex") {
      const found = (s.found || {})[f.kind];
      h += '<label class="field"><span>' + PR.t("模型") + "</span>" + PR.cliModelSelect(s, f.kind, f.model, 'id="cmModel"') + "</label>" +
        (found && !found.found ? '<p class="hint">' + PR.t("本机没找到 {name}", { name: f.kind === "claude" ? '<a href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noopener">Claude Code</a>' : "Codex CLI" }) + "</p>" : "");
    } else {
      h += PR.apiForm.html(s, f, { keyProp: "key", vision: false });
    }
    h += PR.modelReasoningFields(s, f);
    return h + '<div class="cm-form-acts"><span class="grow"></span>' +
      '<button class="btn sm" data-cm="cancel">' + (s.editing === "new" ? PR.t("取消") : PR.t("关闭")) + '</button>' + (s.editing === "new" ? '<button class="btn sm accent" data-cm="ok">' + PR.t("添加") + "</button>" : "") + "</div></div>";
  }
  function autoName(s, f) {
    if (f.kind === "claude" || f.kind === "codex") {  // 卡片名就是模型名
      const o = PR.cliModelOptions(s, f.kind, f.model).find(([v]) => v === (f.model || ""));
      return o ? o[1] : f.model || (f.kind === "claude" ? "Claude" : "GPT");
    }
    const p = preset(s, f.preset);
    return f.model ? PR.apiModelName(s, f.preset, f.model) : p ? p.name : "模型";  // i18n-ok 存进模型名单的名字
  }
  function toModel(s, f, p) {
    const api = isApi(f.kind), name = autoName(s, f);
    return { engine: api ? "openai" : f.kind, preset: api ? f.preset : "",
      base_url: api && (!p || f.base_url !== p.base_url) ? f.base_url : "", api: api && (!p || f.api !== (p.api || "chat")) ? f.api : "", model: f.model, name, label: name,
      source: api ? (p ? p.name : "自定义地址") :  // i18n-ok 存进模型名单的来源名
      f.kind === "claude" ? "Claude Code" : "Codex CLI",
      reasoning_effort: f.reasoning_effort || "", service_tier: f.kind === "claude" ? "" : f.service_tier || "",
      detail: f.model, ready: true };
  }
  function readForm(s) {
    const f = s.form;
    if (!f) return;
    const v = (id) => { const el = PR.$("#" + id); return el ? el.value.trim() : null; };
    if (isApi(f.kind)) PR.apiForm.read(root(), f, "key");
    else if (v("cmModel") !== null) f.model = v("cmModel");
    for (const key of ["reasoning_effort", "service_tier"]) {
      const el = PR.$('[data-reasoning="' + key + '"]', root());
      if (el) f[key] = el.value;
    }
  }
  function startForm(s, m) {
    const p = m && preset(s, m.preset);
    s.form = m ? { kind: kindOf(m), model: m.model || "", preset: m.preset || "", base_url: m.base_url || (p ? p.base_url : ""), api: m.api || (p && p.api) || "chat", vision: false,
      name: "", key: "" }
      : { kind: "claude", model: "opus", preset: "", base_url: "", api: "", name: "", key: "" };
    s.fetchMsg = null; s.apiTyping = false;
    s.form.reasoning_effort = m && m.reasoning_effort || "";
    s.form.service_tier = m && m.service_tier || "";
  }

  /* ---------- 翻译自己的设置 ---------- */
  function translationHtml(s) {
    const c = s.cfg, ti = transIndex(s), m = s.chat.models[ti];
    const e = c.engine;
    let h = '<h4 class="set-h">' + (m ? PR.t("翻译：{name}", { name: PR.esc(m.label || m.name) }) : PR.t("翻译")) + "</h4>";
    if (c.review_policy) h += '<p role="status">' + PR.esc(c.review_policy.mode) + ' · ' + PR.esc(PR.t(c.review_policy.reason || "")) + '</p>';
    if (m) h += '<p class="hint">' + PR.t("推理强度") + ': ' + PR.esc(m.reasoning_effort || PR.modelDefaultLabel(s, { kind: kindOf(m), model: m.model }, "reasoning_effort")) +
      (e === "claude" ? "" : ' · Fast: ' + PR.esc(m.service_tier || PR.modelDefaultLabel(s, { kind: kindOf(m), model: m.model }, "service_tier"))) + '</p>';
    if (e === "openai") h += '<label class="check" style="margin:0 0 10px"><input type="checkbox" data-k="openai.vision"' + (c.openai.vision ? " checked" : "") + ">" + PR.t("模型能看图") + "</label>";
    h += '<div class="grid2 translation-limits">' +
      '<label class="field"><span>' + PR.t("每批页数") + '</span><select class="input" data-k="batch_pages">' + PR.opt([[1, PR.t("1 页")], [2, PR.t("2 页")], [3, PR.t("3 页")], [4, PR.t("4 页")]], c.batch_pages) + "</select></label>" +
      '<label class="field" title="' + PR.t("把全文切成几段同时译，段内按顺序译；自动按篇幅每段约 2 批、最多 4 段；手动最多 8 段") + '"><span>' + PR.t("同时译几段") + '</span><select class="input" data-k="concurrency">' + PR.opt([[0, PR.t("自动")], [1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"], [7, "7"], [8, "8"]], c.concurrency || 0) + "</select></label>" +
      '<label class="field"><span>' + PR.t("超过多少页先问我") + '</span><select class="input" data-k="page_cap">' + PR.opt([30, 60, 100, 200].map((n) => [n, PR.t("{n} 页", { n })]).concat([[0, PR.t("不限")]]), c.page_cap == null ? 60 : c.page_cap) + "</select></label></div>" +
      '<div class="test-line"><button class="btn sm line" id="testBtn">' + PR.icon("sparkle", "sm") + PR.t("试译一句") + '</button><span class="test-result" id="testRes"></span></div>';
    return h;
  }
  /* 页面上翻译那几项的值读回 cfg（存的时候 settings.js 从 cfg 取） */
  function readTranslation(s) {
    PR.$$("[data-k]", root()).forEach((el) => {
      const [a, b] = el.dataset.k.split(".");
      const v = el.type === "checkbox" ? el.checked : el.value;
      if (b) s.cfg[a][b] = v; else s.cfg[a] = ["batch_pages", "concurrency", "page_cap"].includes(a) ? +v : v;
    });
  }

  function commitForm(s) {
    const list = s.chat.models;
    const f = s.form, api = isApi(f.kind), p = preset(s, f.preset);
    if (api && !p && !f.base_url) { PR.toast(PR.t("填接口地址")); return false; }
    if (api && !f.model) { PR.toast(PR.t("填一个模型名")); return false; }
    const typed = f.key && !f.key.startsWith("••••") ? f.key : "";
    if (api && p && p.key && !PR.apiHasKey(s, f.preset) && !typed) { PR.toast(PR.t("这家要填 API Key")); return false; }
    if (api && typed) (s.chatKeys = s.chatKeys || {})[f.preset] = typed;
    const m = toModel(s, f, p);
    if (s.editing === "new") list.push(Object.assign(m, { id: "m" + Date.now().toString(36) }));
    else {
      const old = list.find((x) => x.id === s.editing), wasTr = sameAsTranslation(s, old);
      Object.assign(old, m);
      if (wasTr) useForTranslation(s, old);  // 改的是翻译用的那张：翻译跟着改
    }
    return true;
  }
  function autoSaveForm(s) {
    if (!s.form || s.editing === "new") return;
    if (commitForm(s)) PR.saveModelSettings();
  }

  T.chat = {
    render(s) {
      if (!s.chat) return '<p class="hint">' + PR.t("读不到模型名单。") + "</p>";
      pinDefaults(s);
      ensureTranslationCard(s);
      return cardsHtml(s) + (s.editing ? formHtml(s) : "") +
        '<div class="settings-sec">' + translationHtml(s) + "</div>" +
        '<p class="hint" style="margin-top:14px">' + PR.t("文献库位置：{path}", { path: PR.esc(s.cfg.library_dir) }) + "</p>";
    },
    sync(s) { readForm(s); readTranslation(s); },
    change(e, s) {
      if (e.target.dataset.k) { readTranslation(s); PR.saveModelSettings(); return false; }
      if (e.target.dataset.reasoning) { readForm(s); autoSaveForm(s); return true; }
      if (s.form && isApi(s.form.kind)) {
        if (e.target.dataset.af === "preset") {
          s.form.reasoning_effort = s.form.service_tier = "";
          const changed = PR.apiForm.change(e, s, s.form, "key", root());
          autoSaveForm(s); return changed;
        }
        readForm(s);
        if (e.target.dataset.af === "model") s.form.reasoning_effort = s.form.service_tier = "";
        const changed = PR.apiForm.change(e, s, s.form, "key", root());
        autoSaveForm(s); return changed;
      }
      if (e.target.id === "cmModel" && e.target.tagName === "SELECT") { readForm(s); s.form.reasoning_effort = s.form.service_tier = ""; autoSaveForm(s); return true; }
      return false;
    },
    async click(e, s) {
      if (e.target.closest("#testBtn")) {
        readTranslation(s);
        const res = PR.$("#testRes");
        res.className = "test-result"; res.innerHTML = '<span class="spin"></span> ' + PR.t("正在让模型回一句话…");
        try {
          await PR.api("/api/config", { method: "POST", body: T.engine.collect(s) });
          const r = await PR.api("/api/config/test", { method: "POST", body: { engine: s.cfg.engine } });
          res.className = "test-result " + (r.ok ? "ok" : "bad"); res.textContent = (r.ok ? "✓ " : "✗ ") + r.message;
        } catch (err) { res.className = "test-result bad"; res.textContent = err.message; }
        return false;
      }
      const k = e.target.closest("[data-cmk]");
      if (k && s.form) {
        readForm(s);
        const f = s.form, kind = k.dataset.cmk;
        if (kind === f.kind) return false;
        Object.assign(f, { kind, model: kind === "claude" ? "opus" : PR.cliPin(s, kind, ""), name: "", key: "", base_url: "", api: "", reasoning_effort: "", service_tier: "" });
        s.fetchMsg = null; s.apiTyping = false;
        if (isApi(kind)) {  // 先给一家：翻译那边用的 API，没有就 DeepSeek
          const o = s.cfg.openai;
          PR.apiForm.pick(s, f, s.cfg.engine === "openai" && o.preset ? o.preset : "deepseek", "key");
        }
        autoSaveForm(s);
        return true;
      }
      if (s.form && isApi(s.form.kind) && e.target.closest("[data-fetch-models]")) {
        readForm(s);
        const changed = await PR.apiForm.click(e, s, s.form, "key", root());
        return changed;
      }
      const b = e.target.closest("[data-cm]");
      if (!b) return false;
      const i = +b.dataset.i, list = s.chat.models, act = b.dataset.cm;
      if (act === "more") {
        const m = list[i], tr = i === transIndex(s);
        readTranslation(s);
        PR.menu(b, [
          { label: PR.t("设为翻译"), icon: "sparkle", disabled: tr, fn: () => { useForTranslation(s, m); PR.saveModelSettings(); PR.settingsRender(); } },
          { label: PR.t("设为问 AI"), icon: "note", disabled: s.chat.default === m.id, fn: () => { s.chat.default = m.id; PR.saveModelSettings(); PR.settingsRender(); } },
          "-",
          { label: PR.t("修改"), icon: "edit", fn: () => { readForm(s); s.editing = m.id; startForm(s, m); PR.settingsRender(); } },
          "-",
          { label: PR.t("删除"), icon: "trash", disabled: tr, fn: async () => {
            if (list.length <= 1) return PR.toast(PR.t("至少留一个模型"));
            if (!(await PR.confirm({ title: PR.t("删除“{name}”？", { name: m.label || m.name }), body: PR.t("已有的对话不受影响。"), ok: PR.t("删除"), danger: true }))) return;
            const at = list.indexOf(m); if (at >= 0) list.splice(at, 1);
            if (s.chat.default === m.id) s.chat.default = list[0].id;
            if (s.editing === m.id) { s.editing = null; s.form = null; }
            PR.saveModelSettings(); PR.settingsRender();
          } },
        ]);
        return false;
      }
      if (act === "add") { readForm(s); s.editing = "new"; startForm(s); }
      if (act === "cancel") { s.editing = null; s.form = null; }
      if (act === "ok") {
        readForm(s);
        if (!commitForm(s)) return false;
        PR.saveModelSettings();
        s.editing = null; s.form = null;
      }
      return true;
    },
  };

  /* 拖动卡片排序 */
  let from = -1;
  const cardAt = (e) => e.target.closest && e.target.closest(".mc-cards .mc[data-i]");
  const clear = () => PR.$$(".mc-cards .mc", root()).forEach((c) => c.classList.remove("dragging", "drop-before", "drop-after"));
  root().addEventListener("dragstart", (e) => {
    const c = cardAt(e);
    if (!c) return;
    from = +c.dataset.i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
    c.classList.add("dragging");
  });
  root().addEventListener("dragover", (e) => {
    const c = cardAt(e);
    if (from < 0 || !c) return;
    e.preventDefault();
    const r = c.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    PR.$$(".mc-cards .mc", root()).forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (+c.dataset.i !== from) c.classList.add(after ? "drop-after" : "drop-before");
  });
  root().addEventListener("drop", (e) => {
    const c = cardAt(e), s = PR.settingsState;
    if (from < 0 || !c || !s.chat) return;
    e.preventDefault();
    const r = c.getBoundingClientRect(), list = s.chat.models;
    let to = +c.dataset.i + (e.clientX > r.left + r.width / 2 ? 1 : 0);
    const [m] = list.splice(from, 1);
    if (to > from) to--;
    list.splice(to, 0, m);
    from = -1;
    T.chat.sync(s);
    PR.saveModelSettings(); PR.settingsRender();
  });
  root().addEventListener("dragend", () => { from = -1; clear(); });
})(window.PR);
