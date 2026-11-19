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
    if (e === "claude" || e === "codex" || e === "antigravity") return (m.model || "") === (c[e].model || "");
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
    if (c.engine === "claude" || c.engine === "codex" || c.engine === "antigravity") c[c.engine].model = PR.cliPin(s, c.engine, c[c.engine].model);
    const list = s.chat.models, seen = {};
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.engine === "claude" || m.engine === "codex" || m.engine === "antigravity") {
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
    if (s.cfg.engine === "none") { s.cfg.engine = "claude"; s.cfg.auto_translate = false; }  // 旧的“不翻译”= 关掉自动翻译
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
      '<div class="engine-cards small">' + card("claude", "Claude Code") + card("codex", "Codex CLI") + card("antigravity", "Antigravity CLI") + card("api", PR.t("API 接口")) + "</div>";
    if (f.kind === "claude" || f.kind === "codex" || f.kind === "antigravity") {
      const found = (s.found || {})[f.kind];
      h += '<label class="field"><span>' + PR.t("模型") + "</span>" + PR.cliModelSelect(s, f.kind, f.model, 'id="cmModel"') + "</label>" +
        (found && !found.found ? '<p class="hint">' + PR.t("本机没找到 {name}", { name: f.kind === "claude" ? '<a href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noopener">Claude Code</a>' : (f.kind === "codex" ? "Codex CLI" : "Antigravity CLI") }) + "</p>" : "");
    } else {
      h += PR.apiForm.html(s, f, { keyProp: "key", vision: false });
    }
    h += PR.modelReasoningFields(s, f);
    h += '<div class="test-line" style="margin-top:10px"><button type="button" class="btn sm line" data-cm="test-form">' + PR.icon("sparkle", "sm") + PR.t("测试此模型") + '</button><span class="test-result" id="formTestRes"></span></div>';
    return h + '<div class="cm-form-acts"><span class="grow"></span>' +
      '<button class="btn sm" data-cm="cancel">' + (s.editing === "new" ? PR.t("取消") : PR.t("关闭")) + '</button>' + (s.editing === "new" ? '<button class="btn sm accent" data-cm="ok">' + PR.t("添加") + "</button>" : "") + "</div></div>";
  }
  function autoName(s, f) {
    if (f.kind === "claude" || f.kind === "codex" || f.kind === "antigravity") {  // 卡片名就是模型名
      const o = PR.cliModelOptions(s, f.kind, f.model).find(([v]) => v === (f.model || ""));
      return o ? o[1] : f.model || (f.kind === "claude" ? "Claude" : (f.kind === "codex" ? "GPT" : "Gemini"));
    }
    const p = preset(s, f.preset);
    return f.model ? PR.apiModelName(s, f.preset, f.model) : p ? p.name : "模型";  // i18n-ok 存进模型名单的名字
  }
  function toModel(s, f, p) {
    const api = isApi(f.kind), name = autoName(s, f);
    return { engine: api ? "openai" : f.kind, preset: api ? f.preset : "",
      base_url: api && (!p || f.base_url !== p.base_url) ? f.base_url : "", api: api && (!p || f.api !== (p.api || "chat")) ? f.api : "", model: f.model, name, label: name,
      source: api ? (p ? p.name : "自定义地址") :  // i18n-ok 存进模型名单的来源名
      f.kind === "claude" ? "Claude Code" : (f.kind === "codex" ? "Codex CLI" : "Antigravity CLI"),
      reasoning_effort: f.reasoning_effort || "", service_tier: (f.kind === "claude" || f.kind === "antigravity") ? "" : f.service_tier || "",
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
    if (m) h += '<p class="hint">' + PR.t("推理强度") + ': ' + PR.esc(m.reasoning_effort || PR.modelDefaultLabel(s, { kind: kindOf(m), model: m.model }, "reasoning_effort")) +
      ((e === "claude" || e === "antigravity") ? "" : ' · Fast: ' + PR.esc(m.service_tier || PR.modelDefaultLabel(s, { kind: kindOf(m), model: m.model }, "service_tier"))) + '</p>';
    if (e === "openai") h += '<label class="check" style="margin:0 0 10px"><input type="checkbox" data-k="openai.vision"' + (c.openai.vision ? " checked" : "") + ">" + PR.t("模型能看图") + "</label>";
    h += '<div class="grid2 translation-limits">' +
      '<label class="field"><span>' + PR.t("每批页数") + '</span><select class="input" data-k="batch_pages">' + PR.opt([[1, PR.t("1 页")], [2, PR.t("2 页")], [3, PR.t("3 页")], [4, PR.t("4 页")]], c.batch_pages) + "</select></label>" +
      '<label class="field" title="' + PR.t("把全文切成几段同时译，段内按顺序译；自动按篇幅每段约 2 批、最多 4 段；手动最多 8 段") + '"><span>' + PR.t("同时译几段") + '</span><select class="input" data-k="concurrency">' + PR.opt([[0, PR.t("自动")], [1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"], [7, "7"], [8, "8"]], c.concurrency || 0) + "</select></label>" +
      '<label class="field"><span>' + PR.t("超过多少页先问我") + '</span><select class="input" data-k="page_cap">' + PR.opt([30, 60, 100, 200].map((n) => [n, PR.t("{n} 页", { n })]).concat([[0, PR.t("不限")]]), c.page_cap == null ? 60 : c.page_cap) + "</select></label></div>" +
      '<label class="field" style="margin:8px 0 10px"><span>' + PR.t("自訂翻譯補充指令（選填）") + '</span><textarea class="input" rows="2" maxlength="2000" data-k="custom_prompt" placeholder="' + PR.esc(PR.t("例：法學論述請維持台灣法律用語，專有名詞首次出現附上原文")) + '">' + PR.esc(c.custom_prompt || "") + "</textarea></label>" +
      '<div class="test-line"><button class="btn sm line" id="testBtn">' + PR.icon("sparkle", "sm") + PR.t("试译一句") + '</button><span class="test-result" id="testRes"></span></div>';
    h += mineruHtml(c);
    return h;
  }
  const MINERU_AGENT_PROMPT = 'Install or update the global `mineru` skill. First, run `npx skills add opendatalab/MinerU --skill mineru --global --yes`. If `npx` is unavailable, fetch https://gcore.jsdelivr.net/gh/opendatalab/MinerU/skills/mineru/SKILL.md, use its content as `mineru/SKILL.md`, and save it under the appropriate global skills directory for the current agent, not in the current project. Also check both global and project-level skills for other installed skills whose names contain `mineru`. Report any matches and ask before removing them. If global memory is available, record this preference there: "Whenever a PDF, image, or Office document needs to be read or parsed, prefer the `mineru` Skill." Do not write this preference to the current project.';

  async function copyPlainText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove();
    return ok;
  }

  function mineruModeNotesHtml() {
    return '<div class="mineru-mode-notes">' +
      "<div>" + PR.t("• 雲端模式：免本機算力與環境設定，但檔案將加密傳輸至第三方雲端伺服器（位於中國大陸）進行解析且受網路傳輸與排隊影響，建議勿上傳機密或敏感文件。") + "</div>" +
      "<div>" + PR.t("• 本地模式：所有解析皆於本機（或指定內網）完成，省去檔案上傳與 API 等待時間（搭配 GPU 速度最快）、資料不外流，適合重視效率與機密的文件。") + "</div>" +
      "</div>";
  }

  function mineruGuideHtml() {
    const ext = ' target="_blank" rel="noopener noreferrer"';
    return '<div class="mg-head"><h2 id="mineruGuideTitle">' + PR.t("PDF 結構解析（MinerU）說明與設定教學") + '</h2>' +
      '<button type="button" class="mg-x" data-close aria-label="' + PR.esc(PR.t("关闭")) + '">' + PR.icon("x", "sm") + "</button></div>" +
      '<div class="mg-body">' +
      '<p class="mg-lead">' + PR.t("MinerU 是專為學術論文與複雜文件設計的開源 PDF 結構解析引擎，能先精準辨識數學公式（轉為 LaTeX）、跨欄／跨頁／合併儲存格表格與圖片座標，再交由模型純文字翻譯，大幅減少排版錯亂與漏譯。") + "</p>" +
      '<div class="mg-links">' +
      '<a href="https://mineru.net"' + ext + ">" + PR.icon("link", "sm") + "<span>" + PR.t("前往 MinerU 官網（mineru.net）") + "</span></a>" +
      '<a href="https://github.com/opendatalab/mineru"' + ext + ">" + PR.icon("link", "sm") + "<span>" + PR.t("GitHub 專案（opendatalab/mineru）") + "</span></a>" +
      "</div>" +
      mineruModeNotesHtml() +
      '<figure class="mg-figure"><div class="mg-img-wrap"><img src="/web/img/mineru-showcase.jpg" alt="' + PR.esc(PR.t("MinerU 解析效果示意圖")) + '"></div>' +
      '<figcaption class="mg-img-cap">' + PR.t("解析效果示意：智慧辨識複雜／跨頁／旋轉表格、精準轉換長公式與嵌套數學結構，並支援分子式與圖表結構化萃取。") + "</figcaption></figure>" +
      '<details class="mg-step"><summary>' + PR.t("方式一：註冊並取得 MinerU Cloud API Token（免架設）") + "</summary><div class=\"mg-step-in\">" +
      '<ol class="mg-steps">' +
      "<li>" + PR.t("前往 {link} 登入或註冊帳號。", { link: '<a href="https://mineru.net"' + ext + ">mineru.net</a>" }) + "</li>" +
      "<li>" + PR.t("點擊上方導覽列的 API，再從左側選單進入 API Management。") + "</li>" +
      "<li>" + PR.t("點擊右側「+ Create Token」建立並複製你的 API Token。") + "</li>" +
      "<li>" + PR.t("回到設定頁，在「MinerU API Token」貼上權杖，即可按「測試 MinerU 連線」確認。") + "</li>" +
      "</ol>" +
      '<figure class="mg-figure" style="margin-bottom:0"><div class="mg-img-wrap"><img src="/web/img/mineru-api-token.png" alt="' + PR.esc(PR.t("MinerU API Management 建立 Token 示意圖")) + '"></div>' +
      '<figcaption class="mg-img-cap">' + PR.t("操作位置示意：登入後點擊上方「API」→ 左側「API Management」→ 右側「+ Create Token」。") + "</figcaption></figure>" +
      "</div></details>" +
      '<details class="mg-step"><summary>' + PR.t("方式二：本地自架 MinerU API（閱讀 GitHub README 或交給 Agent 安裝）") + "</summary><div class=\"mg-step-in\">" +
      '<ol class="mg-steps" style="margin-bottom:8px">' +
      "<li>" + PR.t("手動部署：前往 {link} 依 README 說明啟動本機 API 服務。", { link: '<a href="https://github.com/opendatalab/mineru"' + ext + ">GitHub (opendatalab/mineru)</a>" }) + "</li>" +
      "<li>" + PR.t("啟動後將本設定頁的解析方式改為「本機 / 自架 API」，並填入位址（如 http://127.0.0.1:8000）。") + "</li>" +
      "</ol>" +
      '<div class="mg-agent-box">' +
      '<div class="mg-agent-bar"><b>' + PR.t("或交給 Agent 自動安裝（Agent Workflow）") + '</b><button type="button" class="btn sm line" id="mineruAgentCopyBtn">' + PR.icon("copy", "sm") + PR.t("複製提示詞") + "</button></div>" +
      '<p class="mg-agent-note">' + PR.t("若你使用支援 Skill 的 Coding Agent，可複製以下訊息傳送給 Agent，請它安裝全域 mineru skill 並協助部署：") + "</p>" +
      '<pre class="mg-code" data-no-i18n="1">' + PR.esc(MINERU_AGENT_PROMPT) + "</pre>" +
      "</div></div></details>" +
      "</div>" +
      '<div class="actions mg-foot"><button type="button" class="btn" data-close>' + PR.t("关闭") + "</button></div>";
  }

  function openMineruGuide() {
    let box = document.getElementById("mineruGuideDlg");
    if (!box) {
      box = document.createElement("div");
      box.id = "mineruGuideDlg";
      box.className = "dialog-backdrop mineru-guide-backdrop";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "mineruGuideTitle");
      box.innerHTML = '<div class="dialog mineru-guide-dlg"></div>';
      document.body.appendChild(box);
      box.addEventListener("click", async (ev) => {
        if (ev.target === box || ev.target.closest("[data-close]")) {
          box.classList.remove("open");
          return;
        }
        const cp = ev.target.closest("#mineruAgentCopyBtn");
        if (cp) {
          const ok = await copyPlainText(MINERU_AGENT_PROMPT);
          if (ok) PR.toast(PR.t("已複製給 Agent 的安裝提示詞"));
          else PR.toast(PR.t("複製失敗，請手動選取複製"));
        }
      });
    }
    box.querySelector(".mineru-guide-dlg").innerHTML = mineruGuideHtml();
    requestAnimationFrame(() => box.classList.add("open"));
  }

  function mineruHtml(c) {
    const mu = Object.assign({ enabled: false, mode: "cloud", token: "", base_url: "" }, c.mineru || {});
    let h = '<div class="settings-sec"><h4 class="set-h set-h-row"><span>' + PR.t("PDF 結構解析（MinerU，選配）") + '</span>' +
      '<button type="button" class="help-ico" id="mineruHelpBtn" title="' + PR.esc(PR.t("查看 MinerU 說明與設定教學")) + '" aria-label="' + PR.esc(PR.t("查看 MinerU 說明與設定教學")) + '">' + PR.icon("question", "sm") + '</button></h4>' +
      '<label class="check" style="margin:0 0 6px"><input type="checkbox" data-k="mineru.enabled"' + (mu.enabled ? " checked" : "") + ">" + PR.t("使用 MinerU 解析 PDF 結構後再由模型翻譯") + "</label>" +
      '<p class="hint" style="margin:0 0 8px">' + PR.t("先擷取公式、三線表與圖片座標再純文字翻譯；若連不上或超額會自動回退至內建流程。") + "</p>";
    if (!mu.enabled) return h + "</div>";
    const modeField = '<label class="field"><span>' + PR.t("解析方式") + '</span><select class="input" data-k="mineru.mode">' + PR.opt([["cloud", PR.t("MinerU Cloud（mineru.net）")], ["local", PR.t("本機 / 自架 API")]], mu.mode) + "</select></label>";
    const tokLabel = mu.mode === "local" ? PR.t("存取權杖（選填）") : PR.t("MinerU API Token");
    const tokPh = mu.mode === "local" ? PR.t("無驗證時可留空") : PR.t("填入 mineru.net API Token");
    const tokField = '<label class="field"><span>' + tokLabel + '</span><input class="input" type="password" autocomplete="off" data-k="mineru.token" placeholder="' + PR.esc(tokPh) + '" value="' + PR.esc(mu.token || "") + '"></label>';
    if (mu.mode === "local") {
      h += '<div class="grid2">' + modeField +
        '<label class="field"><span>' + PR.t("本機服務位址（base URL）") + '</span><input class="input" type="url" data-k="mineru.base_url" placeholder="http://127.0.0.1:8000" value="' + PR.esc(mu.base_url || "") + '"></label></div>' +
        '<div style="margin-top:8px">' + tokField + "</div>";
    } else {
      h += '<div class="grid2">' + modeField + tokField + "</div>";
    }
    h += '<div class="test-line" style="margin-top:8px"><button class="btn sm line" id="mineruTestBtn">' + PR.icon("sparkle", "sm") + PR.t("測試 MinerU 連線") + '</button><button class="btn sm line" id="mineruParseTestBtn" title="' + PR.esc(PR.t("實際送出 1 頁測試 PDF 檢查後端模型與解析流程（Cloud 模式將消耗 1 頁額度）")) + '">' + PR.t("實測解析 1 頁") + '</button><span class="test-result" id="mineruTestRes"></span></div></div>';
    return h;
  }
  /* 页面上翻译那几项的值读回 cfg（存的时候 settings.js 从 cfg 取） */
  function readTranslation(s) {
    PR.$$("[data-k]", root()).forEach((el) => {
      const [a, b] = el.dataset.k.split(".");
      const v = el.type === "checkbox" ? el.checked : el.value;
      if (b) (s.cfg[a] = s.cfg[a] || {})[b] = v;
      else if (a === "custom_prompt") s.cfg[a] = String(v || "").slice(0, 2000);
      else s.cfg[a] = ["batch_pages", "concurrency", "page_cap"].includes(a) ? +v : v;
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
    if (s.editing === "new") {
      list.push(Object.assign(m, { id: "m" + Date.now().toString(36) }));
      if (!s.cfg.engine || s.cfg.engine === "none" || transIndex(s) < 0) {
        useForTranslation(s, list[list.length - 1]);
      }
    }
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
      if (e.target.dataset.k) {
        readTranslation(s);
        PR.saveModelSettings();
        return e.target.dataset.k === "mineru.enabled" || e.target.dataset.k === "mineru.mode";
      }
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
      if (e.target.closest("#mineruHelpBtn")) {
        openMineruGuide();
        return false;
      }
      if (e.target.closest("#mineruTestBtn") || e.target.closest("#mineruParseTestBtn")) {
        const smoke = !!e.target.closest("#mineruParseTestBtn");
        readTranslation(s);
        const res = PR.$("#mineruTestRes");
        res.className = "test-result";
        res.innerHTML = '<span class="spin"></span> ' + (smoke ? PR.t("正在實測解析 1 頁 PDF…") : PR.t("正在測試 MinerU 連線…"));
        try {
          const saved = await PR.api("/api/config", { method: "POST", body: T.engine.collect(s) });
          if (saved && saved.config) s.cfg = saved.config;
          const r = await PR.api("/api/mineru/test", { method: "POST", body: { mineru: s.cfg.mineru, smoke } });
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
          { label: PR.t("测试此模型"), icon: "sparkle", fn: async () => {
            PR.toast(PR.t("正在让模型回一句话…"));
            try {
              const body = { engine: m.engine, model: m.model || "", reasoning_effort: m.reasoning_effort || "", service_tier: m.service_tier || "" };
              if (m.engine === "openai") {
                const p = preset(s, m.preset), typed = (s.chatKeys || {})[m.preset];
                body.openai = { preset: m.preset || "", base_url: m.base_url || (p ? p.base_url : ""), api: m.api || "chat", model: m.model, api_key: typed || "••••" };
              }
              const r = await PR.api("/api/config/test", { method: "POST", body });
              PR.toast((r.ok ? "✓ " : "✗ ") + (m.label || m.name) + ": " + r.message);
            } catch (err) {
              PR.toast("✗ " + (m.label || m.name) + ": " + err.message);
            }
          } },
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
      if (act === "test-form") {
        readForm(s);
        const f = s.form, res = PR.$("#formTestRes");
        if (res) { res.className = "test-result"; res.innerHTML = '<span class="spin"></span> ' + PR.t("正在让模型回一句话…"); }
        try {
          const api = isApi(f.kind), p = api ? preset(s, f.preset) : null;
          const body = { engine: api ? "openai" : f.kind, model: f.model || "", reasoning_effort: f.reasoning_effort || "", service_tier: f.service_tier || "" };
          if (api) {
            const typed = f.key && !f.key.startsWith("••••") ? f.key : "";
            body.openai = { preset: f.preset || "", base_url: f.base_url || (p ? p.base_url : ""), api: f.api || (p && p.api) || "chat", model: f.model || "", api_key: typed || (PR.apiHasKey(s, f.preset) ? "••••" : "") };
          }
          const r = await PR.api("/api/config/test", { method: "POST", body });
          if (res) { res.className = "test-result " + (r.ok ? "ok" : "bad"); res.textContent = (r.ok ? "✓ " : "✗ ") + r.message; }
        } catch (err) {
          if (res) { res.className = "test-result bad"; res.textContent = err.message; }
        }
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
