/* 设置对话框（文献库页和阅读页共用）：外壳、分页、保存。
   页：模型（翻译和问 AI 合在一起，settings-chat.js）、阅读 / 侧边栏 / 快捷键（settings-tabs.js 等）。
   本文件里的 engine 不再单独成页，只留它的 collect：存的时候从 cfg 取翻译设置。
   PR.openSettings("keys") 直接打开某一页；不指定就从“模型”页开始（不记上次停在哪页）。 */
(function (PR) {
  "use strict";
  const dlg = () => PR.$("#settingsDlg");
  const ALL_TABS = [["chat", PR.t("模型")], ["reading", PR.t("阅读")], ["library", PR.t("侧边栏")], ["keys", PR.t("快捷键")]];
  const tabs = () => ALL_TABS.filter(([k]) => PR.settingsTabs[k]);  // “侧边栏”页只在文献库页面有
  PR.settingsTabs = PR.settingsTabs || {};
  const st = (PR.settingsState = { tab: "chat", cfg: null, presets: [], groups: [], found: null, chat: null, ui: null });

  PR.opt = (list, val) => list.map(([v, l]) => '<option value="' + PR.esc(v) + '"' + (String(v) === String(val) ? " selected" : "") + ">" + PR.esc(l) + "</option>").join("");

  PR.openSettings = async function (tab) {
    await modelSaveQueue;
    const [d, chat] = await Promise.all([PR.api("/api/config"), PR.api("/api/chat/models").catch(() => null)]);
    Object.assign(st, { tab: typeof tab === "string" && tab !== "engine" ? tab : "chat", cfg: d.config, presets: d.presets, groups: d.groups || [], chat,
      fetchMsg: null, apiTyping: false, advOpen: false, ui: { features: Object.assign({}, PR.features), keys_on: PR.keysOn, keys: Object.assign({}, PR.keymap) },
      theme: PR.ls.get("easyread-prefs", {}).theme || "auto", recording: null, editing: null, form: null, chatKeys: null, type: null, transChecked: false, pinned: false });
    render();
    dlg().classList.add("open");
    // 每次打开都问一次（后端有缓存，很快）：刚装好或更新了 Claude Code / Codex，版本号和模型名单马上跟上
    const r = await PR.api("/api/engines").catch(() => null);
    if (r && (JSON.stringify([r.found, r.models]) !== JSON.stringify([st.found, st.models]))) {
      st.found = r.found; st.models = r.models;
      if (dlg().classList.contains("open")) { sync(); render(); }
    }
  };
  window.addEventListener("focus", async () => {
    if (!dlg().classList.contains("open")) return;
    const r = await PR.api("/api/engines").catch(() => null);
    if (r && JSON.stringify(r.models) !== JSON.stringify(st.models)) {
      sync(); st.models = r.models; st.found = r.found; render();
    }
  });
  const btn = PR.$("#settingsBtn");
  if (btn) btn.onclick = () => PR.openSettings();

  function sync() { const t = PR.settingsTabs[st.tab]; if (t && t.sync) t.sync(st, dlg()); }
  PR.settingsRender = render;
  function render() {
    const t = PR.settingsTabs[st.tab];
    dlg().querySelector(".dialog").innerHTML =
      '<div class="set-head"><h2>' + PR.t("设置") + '</h2><div class="set-tabs">' + tabs().map(([k, l]) => '<button data-set-tab="' + k + '" class="' + (st.tab === k ? "on" : "") + '">' + l + "</button>").join("") + "</div>" + (st.tab === "chat" ? saveStatusHtml() : "") + "</div>" +
      '<div class="set-body">' + (t ? t.render(st) : "") + "</div>" +
      '<div class="actions set-foot"><button class="linkish" id="showLog">' + PR.t("运行日志") + '</button><span class="grow"></span><button class="btn" id="setCancel">' + (st.tab === "chat" ? PR.t("关闭") : PR.t("取消")) + '</button>' + (st.tab === "chat" ? "" : '<button class="btn primary" id="setSave">' + PR.t("保存") + "</button>") + "</div>";
  }

  function saveStatusHtml() {
    return '<span id="modelSaveStatus" class="set-save-status" data-state="' + (st.modelSavePhase || "idle") + '" role="status" aria-live="polite" title="' + PR.esc(st.modelSaveDetail || "") + '">' + PR.esc(st.modelSaveStatus || "") + '</span>';
  }
  let statusTimer, saveRevision = 0;
  function setSaveStatus(phase, text, detail = "") {
    clearTimeout(statusTimer);
    Object.assign(st, { modelSavePhase: phase, modelSaveStatus: text, modelSaveDetail: detail });
    const el = PR.$("#modelSaveStatus");
    if (el) { el.dataset.state = phase; el.textContent = text; el.title = detail; }
    if (phase === "saved") statusTimer = setTimeout(() => setSaveStatus("idle", ""), 2200);
  }

  let modelSaveQueue = Promise.resolve();
  PR.saveModelSettings = function () {
    const config = JSON.parse(JSON.stringify(PR.settingsTabs.engine.collect(st)));
    const chat = JSON.parse(JSON.stringify({ models: st.chat.models, default: st.chat.default, keys: st.chatKeys || {} }));
    const revision = ++saveRevision;
    setSaveStatus("saving", PR.t("正在保存…"));
    modelSaveQueue = modelSaveQueue.then(async () => {
      await PR.api("/api/chat/models", { method: "POST", body: chat });
      await PR.api("/api/config", { method: "POST", body: config });
      if (revision === saveRevision) setSaveStatus("saved", PR.t("已保存"));
      PR.onSettingsSaved && PR.onSettingsSaved();
      PR.emit("settings-saved", st);
    }).catch((err) => {
      if (revision === saveRevision) setSaveStatus("error", PR.t("保存失败"), err.message);
      PR.toast(PR.t("保存失败：{msg}", { msg: err.message }));
    });
    return modelSaveQueue;
  };

  async function save() {
    await modelSaveQueue;
    sync();
    const r = await PR.api("/api/config", { method: "POST", body: PR.settingsTabs.engine.collect(st) });
    st.cfg = r.config;
    if (st.chat) st.chat = await PR.api("/api/chat/models", { method: "POST", body: { models: st.chat.models, default: st.chat.default, keys: st.chatKeys || {} } });
    PR.applyUi(st.ui, true);
    if (window.parent && window.parent !== window && window.parent.easyreadTabs?.setAutoHide) {
      window.parent.easyreadTabs.setAutoHide(!!st.ui.features.autohide_tabs);
    }
    PR.ls.set("easyread-auto-translate", !!st.cfg.auto_translate);
    const prefs = PR.ls.get("easyread-prefs", {});
    if (prefs.theme !== st.theme) { prefs.theme = st.theme; PR.ls.set("easyread-prefs", prefs); PR.savePrefs("reader", { theme: st.theme }); if (PR.prefs) PR.prefs.theme = st.theme; }
    PR.applyTheme(st.theme);
    if (st.type) {  // 排版：阅读页里立刻生效；文献库页只存起来
      PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), st.type));
      if (PR.resetAllType) PR.resetAllType(st.type); else PR.savePrefs("reader", st.type);
    }
    const reloadTarget = () => {
      const w = (window.parent && window.parent !== window && window.parent.easyreadTabs) ? window.parent : window;
      w.location.reload();
    };
    if (st.target && st.target !== PR.target) {  // 译文语言存在 config.json，按钮文字跟着变，所以也刷新一下
      await PR.api("/api/config", { method: "POST", body: { target: st.target } });
      if (!st.lang || st.lang === PR.langChoice) return reloadTarget();
    }
    if (st.lang && st.lang !== PR.langChoice) {  // 换界面语言：存好后刷新，页面由后端按新语言重新生成
      await PR.api("/api/prefs", { method: "POST", body: { ui: { lang: st.lang } } });
      return reloadTarget();
    }
    dlg().classList.remove("open");
    PR.toast(PR.t("设置已保存"));
    PR.onSettingsSaved && PR.onSettingsSaved();
    PR.emit("settings-saved", st);
  }

  PR.formatLogEnglish = function (text) {
    if (!text) return "";
    return text.split(/\r?\n/).map((line) => {
      const mTime = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\s+[A-Z]+)?\s+)(.*)$/);
      const pfx = mTime ? mTime[1] : "";
      let b = mTime ? mTime[2] : line;

      b = b.replace(/^PaperRead\s+([0-9.]+)\s+已[啟启]動[：:]\s*(https?:\/\/[^\s]+)\s+文[獻献][庫库][：:]\s*(.*)$/, "PaperRead $1 started: $2  Library: $3"); // i18n-ok
      const mStarted = b.match(/^(?:只[讀读]原文[（(]不[翻飜]?[譯译][）)]\s*)?[開开]始[：:]\s*(\d+)\s*[頁页][，,]\s*(\d+)\s*批[，,]\s*引擎\s*([^，,]+)[，,]\s*[併并]發\s*(\d+)$/); // i18n-ok
      if (mStarted) {
        const ro = (line.includes("只讀原文") || line.includes("只读原文")) ? "[Read-only] " : ""; // i18n-ok
        b = ro + "Started: " + mStarted[1] + " pages, " + mStarted[2] + " batches, engine " + mStarted[3] + ", concurrency " + mStarted[4];
      }
      const mSeg = b.match(/^分\s*(\d+)\s*段同[時时][譯译][：:](.*)$/); // i18n-ok
      if (mSeg) {
        let sub = mSeg[2]
          .replace(/第\s*(\d+)[–-](\d+)\s*[頁页]/g, "Pages $1–$2") // i18n-ok
          .replace(/第\s*(\d+)\s*[頁页]/g, "Page $1") // i18n-ok
          .replace(/、/g, ", "); // i18n-ok
        b = "Concurrent translation in " + mSeg[1] + " segments: " + sub;
      }
      b = b.replace(/^第\s*(\d+)[–-](\d+)\s*[頁页]\s*完成$/, "Pages $1–$2 completed"); // i18n-ok
      b = b.replace(/^第\s*(\d+)\s*[頁页]\s*完成$/, "Page $1 completed"); // i18n-ok
      b = b.replace(/^第\s*(\d+)[–-](\d+)\s*[頁页]\s*第\s*(\d+)\s*次[失矢]敗[：:]\s*(.*)$/, "Pages $1–$2 failed (attempt $3): $4"); // i18n-ok
      b = b.replace(/^第\s*(\d+)\s*[頁页]\s*第\s*(\d+)\s*次[失矢]敗[：:]\s*(.*)$/, "Page $1 failed (attempt $2): $3"); // i18n-ok
      b = b.replace(/^第\s*(\d+)[–-](\d+)\s*[頁页]\s*第\s*(\d+)\s*次失败[：:]\s*(.*)$/, "Pages $1–$2 failed (attempt $3): $4"); // i18n-ok
      b = b.replace(/^第\s*(\d+)\s*[頁页]\s*第\s*(\d+)\s*次失败[：:]\s*(.*)$/, "Page $1 failed (attempt $2): $3"); // i18n-ok
      b = b.replace(/^第\s*(\d+)[–-](\d+)\s*[頁页]\s*模型整[頁页]漏[譯译]，[單单][獨独]再[譯译]一次$/, "Pages $1–$2 missed entirely by model, retrying individually"); // i18n-ok
      b = b.replace(/^第\s*(\d+)\s*[頁页]\s*模型整[頁页]漏[譯译]，[單单][獨独]再[譯译]一次$/, "Page $1 missed entirely by model, retrying individually"); // i18n-ok
      b = b.replace(/^第\s*(\d+)[–-](\d+)\s*[頁页]修正[失矢]敗，保留原[譯译][：:]\s*(.*)$/, "Pages $1–$2 fix failed, original translation kept: $3"); // i18n-ok
      b = b.replace(/^第\s*(\d+)\s*[頁页]修正[失矢]敗，保留原[譯译][：:]\s*(.*)$/, "Page $1 fix failed, original translation kept: $2"); // i18n-ok
      b = b.replace(/^第\s*(\d+)[–-](\d+)\s*[頁页]修正失败，保留原[译譯][：:]\s*(.*)$/, "Pages $1–$2 fix failed, original translation kept: $3"); // i18n-ok
      b = b.replace(/^第\s*(\d+)\s*[頁页]修正失败，保留原[译譯][：:]\s*(.*)$/, "Page $1 fix failed, original translation kept: $2"); // i18n-ok
      b = b.replace(/^第\s*(\d+)\s*[頁页]起[術术][語语][統统]一[：:](.+?)\s*的[“"「](.+?)[”"」]改成已有的[“"「](.+?)[”"」]$/, 'Terminology unified starting from page $1: "$3" -> "$4" for $2'); // i18n-ok
      const mTc = b.match(/^[術术][語语]一致性[：:]\s*第\s*(\d+)\s*[頁页]\s*(.*)$/); // i18n-ok
      if (mTc) b = "Terminology consistency: Page " + mTc[1] + " " + mTc[2];
      b = b.replace(/^[術术][語语]一致性[檢检]查[：:]\s*[查檢检]了\s*(\d+)\s*段[，,]\s*改了\s*(\d+)\s*段$/, "Terminology consistency check: checked $1 sections, updated $2 sections"); // i18n-ok
      b = b.replace(/^[術术][語语]一致性[檢检]查[：:]\s*沒有[發发]現不一致$/, "Terminology consistency check: no inconsistencies found"); // i18n-ok
      b = b.replace(/^[術术][語语]一致性[檢检]查[：:]\s*没有发现不一致$/, "Terminology consistency check: no inconsistencies found"); // i18n-ok
      b = b.replace(/^[術术][語语]一致性[檢检]查已取消[，,]\s*[譯译]文保留$/, "Terminology consistency check cancelled, translation kept"); // i18n-ok
      b = b.replace(/^[術术][語语]一致性[檢检]查[沒没]做成[：:]\s*(.*)$/, "Terminology consistency check failed: $1"); // i18n-ok
      b = b.replace(/^[術术][語语]一致性[檢检]查[失矢]敗[：:]\s*(.*)$/, "Terminology consistency check failed: $1"); // i18n-ok
      b = b.replace(/^[術术][語语]一致性[檢检]查失败[：:]\s*(.*)$/, "Terminology consistency check failed: $1"); // i18n-ok
      b = b.replace(/^[處处]理完成[，,]\s*但有\s*(\d+)\s*[頁页][失矢]敗[：:]\s*(.*)$/, "Finished, but $1 pages failed: $2"); // i18n-ok
      b = b.replace(/^[處处]理完成[，,]\s*但有\s*(\d+)\s*[頁页]失败[：:]\s*(.*)$/, "Finished, but $1 pages failed: $2"); // i18n-ok
      b = b.replace(/^[結结]束[，,]\s*全部成功$/, "Finished, all successful"); // i18n-ok
      b = b.replace(/^[結结]束[，,]\s*(\d+)\s*[頁页][失矢]敗[：:]\s*(.*)$/, "Finished, $1 pages failed: $2"); // i18n-ok
      b = b.replace(/^[結结]束[，,]\s*(\d+)\s*[頁页]失败[：:]\s*(.*)$/, "Finished, $1 pages failed: $2"); // i18n-ok
      b = b.replace(/^[額额]度用完或[連连]不上[，,]\s*停止[翻飜]?[譯译]剩下的[頁页]$/, "Quota exceeded or connection lost, stopping remaining pages"); // i18n-ok
      b = b.replace(/^出[錯错]停止[：:]\s*(.*)$/, "Stopped due to error: $1"); // i18n-ok
      b = b.replace(/^核[對对]提示[沒没]存上[：:]\s*(.*)$/, "Verification prompt failed to save: $1"); // i18n-ok
      b = b.replace(/^改[為为]常[駐驻][，,]\s*不再在[頁页]面[關关]掉[後后]自[動动]退出$/, "Daemon mode enabled; staying open after page close"); // i18n-ok
      b = b.replace(/^[頁页]面都[關关]了[，,]\s*[後后]台[沒没]有任[務务]在跑[，,]\s*退出服[務务]$/, "All pages closed with no active background jobs, shutting down server"); // i18n-ok
      b = b.replace(/^[檢检]查新版本[沒没]成功[：:]\s*(.*)$/, "Check for update failed: $1"); // i18n-ok
      b = b.replace(/^證[書书]校[驗验][失矢]敗\s*(.*?)[：:]\s*(.*)$/, "Certificate verification failed $1: $2"); // i18n-ok
      b = b.replace(/^证书校验失败\s*(.*?)[：:]\s*(.*)$/, "Certificate verification failed $1: $2"); // i18n-ok
      b = b.replace(/^[連连]通性[檢检]查[失矢]敗\s*(.*?)[：:]\s*(.*)$/, "Connectivity check failed $1: $2"); // i18n-ok
      b = b.replace(/^[翻飜]?[譯译][失矢]敗\s*(.*)$/, "Translation failed $1"); // i18n-ok
      b = b.replace(/^翻译失败\s*(.*)$/, "Translation failed $1"); // i18n-ok
      b = b.replace(/^導[入入][失矢]敗\s*(.*)$/, "Import failed $1"); // i18n-ok
      b = b.replace(/^导入失败\s*(.*)$/, "Import failed $1"); // i18n-ok
      b = b.replace(/必須是二維陣列/g, "must be a 2D array").replace(/必须是二维数组/g, "must be a 2D array"); // i18n-ok
      b = b.replace(/^[（(]完整[日誌日志]+[：:]\s*(.*?)[）)]$/, "(full log: $1)"); // i18n-ok

      return pfx + b;
    }).join("\n");
  };

  PR.showText = function (title, text) {
    const d = PR.$("#textDlg");
    const bodyText = PR.formatLogEnglish(text);
    d.querySelector(".dialog").innerHTML = "<h2>" + PR.esc(title) + '</h2><pre class="logview">' + PR.esc(bodyText || PR.t("（还没有记录）")) + '</pre><div class="actions"><button class="btn" data-close>' + PR.t("关闭") + "</button></div>";
    d.classList.add("open");
    const pre = d.querySelector("pre"); pre.scrollTop = pre.scrollHeight;
  };
  const td = PR.$("#textDlg");
  if (td) td.addEventListener("click", (e) => { if (e.target.id === "textDlg" || e.target.closest("[data-close]")) td.classList.remove("open"); });

  dlg().addEventListener("click", async (e) => {
    if (e.target === dlg() || e.target.closest("#setCancel")) { st.recording = null; return dlg().classList.remove("open"); }
    const tb = e.target.closest("[data-set-tab]");
    if (tb) { sync(); st.tab = tb.dataset.setTab; st.recording = null; st.editing = null; render(); return; }
    if (e.target.closest("#showLog")) { const r = await PR.api("/api/log"); PR.showText(PR.t("运行日志"), r.text + "\n\n" + PR.t("（完整日志：{path}）", { path: r.path })); return; }
    if (e.target.closest("#setSave")) { try { await save(); } catch (err) { PR.toast(PR.t("保存失败：{msg}", { msg: PR.esc(err.message) })); } return; }
    const t = PR.settingsTabs[st.tab];
    if (t && t.click && (await t.click(e, st, dlg()))) render();
  });
  dlg().addEventListener("change", (e) => {
    const t = PR.settingsTabs[st.tab];
    if (t && t.change && t.change(e, st, dlg())) render();
  });
  document.addEventListener("keydown", (e) => {
    if (!dlg().classList.contains("open")) return;
    const t = PR.settingsTabs[st.tab];
    if (st.recording && t && t.key) { e.preventDefault(); e.stopImmediatePropagation(); if (t.key(e, st)) render(); return; }
    if (e.key === "Escape") dlg().classList.remove("open");
  }, true);

  /* ---------- 翻译设置：存的时候从 cfg 取（页面在 settings-chat.js，改动随时写回 cfg） ---------- */
  PR.settingsTabs.engine = {
    collect(state) {
      const c = state.cfg, o = c.openai, a = c.antigravity || {};
      return { engine: c.engine, batch_pages: c.batch_pages, concurrency: c.concurrency, page_cap: c.page_cap, auto_translate: c.auto_translate,
        claude: { model: c.claude.model, command: c.claude.command, reasoning_effort: c.claude.reasoning_effort || "" },
        codex: { model: c.codex.model, command: c.codex.command, reasoning_effort: c.codex.reasoning_effort || "", service_tier: c.codex.service_tier || "" },
        antigravity: { model: a.model || "", command: a.command || "agy", reasoning_effort: a.reasoning_effort || "" },
        openai: { preset: o.preset, base_url: o.base_url, api: o.api, model: o.model, api_key: o.api_key, vision: o.vision,
          reasoning_effort: o.reasoning_effort || "", service_tier: o.service_tier || "" } };
    },
  };
})(window.PR);
