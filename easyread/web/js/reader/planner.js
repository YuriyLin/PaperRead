/* Research context for the currently open paper. */
(function (PR) {
  "use strict";
  const S = PR.state, API = "/api/research/v2";
  PR.researchOpen = () => PR.side === "research";
  PR.toggleResearch = function (force) {
    const open = force == null ? PR.side !== "research" : Boolean(force);
    PR.openSide(open ? "research" : null);
    if (open) render();
  };

  function paperTitle() { return S.paper?.meta?.title_zh || S.paper?.meta?.title_en || PR.t("這篇論文"); }
  const titleHtml = (value, fallback = "") => PR.titleHtml ? PR.titleHtml(value || fallback) : PR.esc(value || fallback);
  function cleanTopicQuery(title) {
    if (!title) return "";
    let s = (PR.titleText ? PR.titleText(title) : String(title)).trim();
    s = s.replace(/\\[a-zA-Z]+(?:\{([^}]*)\})?/g, (m, inner) => inner || "");
    const colonMatch = s.match(/^([A-Za-z0-9_.-]{2,25})\s*:\s*(.+)$/);
    if (colonMatch) {
      const prefix = colonMatch[1], rest = colonMatch[2];
      if (rest.length >= 10 && !/^(?:a|an|the|on|towards?)\b/i.test(prefix)) {
        s = rest;
      }
    }
    s = s.replace(/^(?:a|an|the)\s+/i, "");
    s = s.replace(/^(?:towards?|on|about)\s+/i, "");
    s = s.replace(/^(?:understanding|exploring|investigating|evaluating|advancing|benchmarking|rethinking|improving)\s+/i, "");
    s = s.replace(/^(?:novel|new|efficient|effective|scalable|robust|unified|comprehensive|empirical|comparative|systematic|exploratory)\s+/i, "");
    s = s.replace(/^(?:approach|framework|study|survey|analysis|method|methodology|investigation|evaluation|perspective|architecture|system|paradigm)\s+(?:for|to|on|of|in)\s+/i, "");
    s = s.replace(/^(?:for|to|on|of|in)\s+/i, "");
    s = s.replace(/^(?:a|an|the)\s+/i, "");
    s = s.replace(/[:\-–—]\s*(?:an?\s+)?(?:novel|empirical|comprehensive|systematic|comparative)?\s*(?:approach|framework|study|survey|analysis|perspective|review|benchmarking?|tutorial)\s*$/i, "");
    s = s.replace(/\s+/g, " ").trim();
    return s || String(title).trim();
  }
  function openUrl(path, params) { const url = new URLSearchParams(params); return path + "?" + url.toString(); }
  function mindmapEmpty() {
    return '<div class="rp-map-empty"><svg viewBox="0 0 180 104" role="img" aria-label="研究心智圖示意圖" xmlns="http://www.w3.org/2000/svg"><path d="M90 50 42 24M90 50 139 24M90 50 42 80M90 50 139 80" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="67" y="36" width="46" height="28" rx="10" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2"/><rect x="18" y="12" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><rect x="115" y="12" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><rect x="18" y="69" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><rect x="115" y="69" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><circle cx="90" cy="50" r="4" fill="var(--accent)"/></svg><p>' + PR.t("尚未產生心智圖") + '</p><span>' + PR.t("產生後會在這裡呈現論文的研究脈絡。") + '</span></div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  function parseMindmap(source) {
    const root = document.createElement("ul"); root.className = "rp-tree";
    const stack = [{ depth: -1, list: root }];
    for (const line of String(source || "").split(/\r?\n/)) {
      if (!line.trim() || /^\s*mindmap\s*$/i.test(line)) continue;
      const spaces = (line.match(/^\s*/) || [""])[0].replace(/\t/g, "  ").length;
      let label = line.trim();
      // Mermaid mindmap labels may have an explicit node id followed by a
      // shape delimiter. Plain labels (including Chinese text) must stay intact.
      label = label.replace(/^[\w-]+(?=\(\(|\[|\{|\()/, "");
      label = label.replace(/^root\(\((.*)\)\)$/i, "$1").replace(/^\(\((.*)\)\)$/, "$1").replace(/^\((.*)\)$/, "$1").replace(/^\[(.*)\]$/, "$1").replace(/^\{(.*)\}$/, "$1").trim();
      if (!label) continue;
      while (stack.length > 1 && stack.at(-1).depth >= spaces) stack.pop();
      const item = document.createElement("li"), node = document.createElement("span");
      node.className = stack.length === 1 ? "rp-node root" : "rp-node";
      node.innerHTML = titleHtml(label.slice(0, 180));
      item.append(node); stack.at(-1).list.append(item);
      const children = document.createElement("ul"); item.append(children); stack.push({ depth: spaces, list: children });
    }
    return root;
  }
  let activeMindmapCtrl = null;
  let lastGeneratedMindmap = null;

  function displayMindmap(box, data) {
    const view = box.querySelector("#rp-mindmap"); if (!view) return;
    const expandBtn = box.querySelector("#rp-map-expand");
    const title = paperTitle();
    if (activeMindmapCtrl) {
      activeMindmapCtrl.destroy();
      activeMindmapCtrl = null;
    }
    if (PR.mindmap && PR.mindmap.renderPanel) {
      activeMindmapCtrl = PR.mindmap.renderPanel(view, data, {
        title,
        onRegenerate: () => renderMindmap(box, true),
      });
    } else {
      view.replaceChildren(parseMindmap(data.mermaid));
    }
    const note = document.createElement("small"); note.className = "rp-map-meta"; note.textContent = PR.t("依目前論文文字產生 · {model}", { model: data.model || PR.t("快取結果") }); view.append(note);
    if (expandBtn) expandBtn.style.display = "";
  }

  async function renderMindmap(box, force = false) {
    const view = box.querySelector("#rp-mindmap"); if (!view) return;
    const button = box.querySelector("#rp-map-generate");
    const expandBtn = box.querySelector("#rp-map-expand");
    const defaultLabel = PR.t("產生／更新心智圖");
    const id = encodeURIComponent(PR.pid);

    if (force) {
      if (button) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = PR.t("正在重新產生…");
      }
      if (activeMindmapCtrl) {
        activeMindmapCtrl.destroy();
        activeMindmapCtrl = null;
      }
      view.replaceChildren(); view.setAttribute("aria-live", "polite");
      view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.t("正在依據論文內文產生心智圖…") + '</span></div>';
      if (expandBtn) expandBtn.style.display = "none";
      try {
        const res = await PR.api(API + "/paper/" + id + "/mindmap/tasks", { method: "POST", body: { force: true } });
        PR.researchTaskMonitor?.track(res.task, true);
        if (res.task && res.task.state === "completed" && res.task.result) {
          lastGeneratedMindmap = res.task.result;
          displayMindmap(box, res.task.result);
          if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
        }
      } catch (error) {
        if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
        view.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(error.message) + '</span><button class="btn sm line" data-rp-map-retry>' + PR.t("重試") + '</button></div>';
      }
      return;
    }

    if (activeMindmapCtrl) {
      activeMindmapCtrl.destroy();
      activeMindmapCtrl = null;
    }
    view.replaceChildren(); view.setAttribute("aria-live", "polite");
    view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.t("正在根據論文內文整理研究心智圖…") + '</span></div>';
    if (expandBtn) expandBtn.style.display = "none";
    try {
      const result = await PR.api(API + "/paper/" + id + "/mindmap");
      const liveTask = result?.task;
      if (liveTask && ["queued", "running", "cancelling"].includes(liveTask.state)) {
        if (button) {
          button.disabled = true;
          button.setAttribute("aria-busy", "true");
          button.textContent = PR.t("正在重新產生…");
        }
        view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.esc(liveTask.message || PR.t("正在依據論文內文產生心智圖…")) + '</span></div>';
        PR.researchTaskMonitor?.track(liveTask, false);
        return;
      }
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = defaultLabel;
      }
      if (!result?.mermaid) { view.innerHTML = mindmapEmpty(); return; }
      lastGeneratedMindmap = result;
      displayMindmap(box, result);
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = defaultLabel;
      }
      view.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(error.message) + '</span><button class="btn sm line" data-rp-map-retry>' + PR.t("重試") + '</button></div>';
    }
  }
  let lastGeneratedReport = null;

  function deepReportEmpty() {
    return '<div class="rp-map-empty"><svg viewBox="0 0 180 104" role="img" aria-label="論文深度剖析示意圖" xmlns="http://www.w3.org/2000/svg"><rect x="30" y="16" width="120" height="72" rx="8" fill="var(--surface)" stroke="currentColor" stroke-width="2"/><line x1="45" y1="34" x2="105" y2="34" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line x1="45" y1="48" x2="135" y2="48" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="45" y1="60" x2="120" y2="60" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="125" cy="34" r="5" fill="var(--accent)"/></svg><p>' + PR.t("尚未產生深度剖析報告") + '</p><span>' + PR.t("產生後會在此呈現客觀技術審計、消融對照與公式微型推導。") + '</span></div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }

  function displayDeepReport(box, data) {
    const view = box.querySelector("#rp-deep-report"); if (!view) return;
    const expandBtn = box.querySelector("#rp-deep-expand");
    const md = data.markdown || "";
    const snippet = md.length > 360 ? md.slice(0, 360) + "…" : md;
    view.replaceChildren();
    const content = document.createElement("div");
    content.className = "rp-deep-preview markdown";
    content.innerHTML = PR.mdBlocks ? PR.mdBlocks(snippet) : PR.esc(snippet);
    view.append(content);
    const note = document.createElement("small");
    note.className = "rp-map-meta";
    note.textContent = PR.t("依目前論文文字產生 · {model}", { model: data.model || PR.t("快取結果") });
    view.append(note);
    if (expandBtn) expandBtn.style.display = "";
  }

  async function renderDeepAnalysis(box, force = false) {
    const view = box.querySelector("#rp-deep-report"); if (!view) return;
    const button = box.querySelector("#rp-deep-generate");
    const expandBtn = box.querySelector("#rp-deep-expand");
    const defaultLabel = PR.t("產生／更新深度剖析報告");
    const id = encodeURIComponent(PR.pid);

    if (force) {
      if (button) {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = PR.t("正在重新產生…");
      }
      view.replaceChildren(); view.setAttribute("aria-live", "polite");
      view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.t("正在依據論文內文進行技術審計…") + '</span></div>';
      if (expandBtn) expandBtn.style.display = "none";
      try {
        const res = await PR.api(API + "/paper/" + id + "/deep-analysis/tasks", { method: "POST", body: { force: true } });
        PR.researchTaskMonitor?.track(res.task, true);
        if (res.task && res.task.state === "completed" && res.task.result) {
          lastGeneratedReport = res.task.result;
          displayDeepReport(box, res.task.result);
          if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
        }
      } catch (error) {
        if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
        view.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(error.message) + '</span><button class="btn sm line" data-rp-deep-retry>' + PR.t("重試") + '</button></div>';
      }
      return;
    }

    view.replaceChildren(); view.setAttribute("aria-live", "polite");
    view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.t("正在讀取深度剖析報告…") + '</span></div>';
    if (expandBtn) expandBtn.style.display = "none";
    try {
      const result = await PR.api(API + "/paper/" + id + "/deep-analysis");
      const liveTask = result?.task;
      if (liveTask && ["queued", "running", "cancelling"].includes(liveTask.state)) {
        if (button) {
          button.disabled = true;
          button.setAttribute("aria-busy", "true");
          button.textContent = PR.t("正在重新產生…");
        }
        view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.esc(liveTask.message || PR.t("正在依據論文內文進行技術審計…")) + '</span></div>';
        PR.researchTaskMonitor?.track(liveTask, false);
        return;
      }
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = defaultLabel;
      }
      if (!result?.report || !result.report.markdown) { view.innerHTML = deepReportEmpty(); return; }
      lastGeneratedReport = result.report;
      displayDeepReport(box, result.report);
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = defaultLabel;
      }
      view.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(error.message) + '</span><button class="btn sm line" data-rp-deep-retry>' + PR.t("重試") + '</button></div>';
    }
  }

  function openDeepReportModal(report) {
    if (!report?.markdown) return;
    const dlg = PR.$("#deepReportDlg");
    if (!dlg) return;
    const dlgBox = dlg.querySelector(".dialog");
    const title = paperTitle();
    dlgBox.innerHTML = '<div class="deep-modal-head"><div class="deep-modal-title"><b>' + PR.t("論文深度剖析報告") + '</b><span>' + PR.esc(title) + '</span></div><div class="deep-modal-actions">' +
      '<button type="button" class="btn sm line" id="deepModalCopy">' + PR.t("複製 Markdown") + '</button>' +
      '<button type="button" class="btn icon line" id="deepModalClose" aria-label="' + PR.t("關閉") + '">×</button></div></div>' +
      '<div class="deep-modal-body markdown">' + (PR.mdBlocks ? PR.mdBlocks(report.markdown) : PR.esc(report.markdown)) + '</div>';
    dlg.classList.add("open");
    dlg.querySelector("#deepModalClose").onclick = () => dlg.classList.remove("open");
    dlg.onclick = (e) => { if (e.target === dlg) dlg.classList.remove("open"); };
    dlg.querySelector("#deepModalCopy").onclick = async () => {
      await navigator.clipboard.writeText(report.markdown);
      PR.toast(PR.t("已複製 Markdown 內容至剪貼簿！"));
    };
  }

  async function render() {
    const box = PR.$("#researchpanel"), id = PR.pid, item = S.item || {};
    const title = paperTitle();
    const openalexId = S.paper?.meta?.openalex_id || S.item?.openalex_id || "";
    const doi = S.paper?.meta?.doi || S.item?.doi || "";
    const cleanTopic = cleanTopicQuery(S.paper?.meta?.title_en || title);
    let researchLink;
    if (openalexId || doi) {
      researchLink = openUrl("/research", {
        mode: "relation",
        work: openalexId || ("doi:" + doi),
        relation: "related",
        start_title: title,
        start_doi: doi,
        q: cleanTopic,
      });
    } else {
      researchLink = openUrl("/research", {
        mode: "topic",
        q: cleanTopic,
        start_title: title,
      });
    }
    const params = {
      mode: "path",
      q: cleanTopic,
      start_title: title,
      start_doi: doi,
      start_openalex: openalexId,
    };
    const interested = Boolean(item.starred ?? item.interested);
    box.innerHTML = '<div class="research-v2-head"><b>' + PR.t("研究脈絡") + '</b><button data-rp-close aria-label="關閉">×</button></div><div class="research-v2-body"><div class="rp-current">' + titleHtml(title) + '</div><section class="rp-section"><div class="rp-section-titleline"><h3>' + PR.t("論文心智圖") + '</h3><button type="button" class="btn sm line rp-btn-expand" id="rp-map-expand" style="display:none">' + PR.t("詳細檢視") + '</button></div><p class="hint">' + PR.t("根據目前論文整理研究問題、方法、發現、貢獻與限制。") + '</p><div id="rp-mindmap" class="rp-mindmap"></div><button class="btn accent" id="rp-map-generate">' + PR.t("產生／更新心智圖") + '</button></section><section class="rp-section"><div class="rp-section-titleline"><h3>' + PR.t("論文深度剖析") + '</h3><button type="button" class="btn sm line rp-btn-expand" id="rp-deep-expand" style="display:none">' + PR.t("詳細檢視") + '</button></div><p class="hint">' + PR.t("客觀審查核心假說與實證、消融對照、關鍵公式微型推導與研究限制。") + '</p><div id="rp-deep-report" class="rp-deep-report"></div><div class="rp-deep-actions"><button class="btn accent" id="rp-deep-generate">' + PR.t("產生／更新深度剖析報告") + '</button></div></section><section class="rp-section"><h3>' + PR.t("延伸探索") + '</h3><a class="btn line" href="' + PR.esc(researchLink) + '">' + PR.t("以此論文探索相關研究") + '</a><a class="btn line" href="' + PR.esc(openUrl("/research", params)) + '">' + PR.t("探索研究方向與閱讀路徑") + '</a><a class="btn line" href="' + PR.esc(openUrl("/research", { mode: "candidates", q: cleanTopic, start_title: title })) + '">' + PR.t("前往候選清單") + '</a></section><section class="rp-section"><h3>' + PR.t("閱讀狀態") + '</h3><div class="rp-status-controls"><div id="rp-status-options" class="seg rp-status-segment" role="group" aria-label="閱讀狀態"></div><button type="button" class="btn icon line rp-interest-star' + (interested ? ' is-interested' : '') + '" id="rp-interested" aria-label="' + PR.esc(PR.t(interested ? '取消感興趣' : '標記感興趣')) + '" title="' + PR.esc(PR.t(interested ? '取消感興趣' : '標記感興趣')) + '" aria-pressed="' + interested + '">' + PR.icon("star", "sm") + '</button></div><p class="hint">' + PR.t("閱讀進度依閱讀器紀錄，和是否理解或整理論文分開。") + '</p><div id="rp-status-feedback" class="hint" role="status" aria-live="polite"></div></section></div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    renderMindmap(box);
    renderDeepAnalysis(box);
    try {
      const data = await PR.api(API);
      const options = box.querySelector("#rp-status-options"), statuses = (data.statuses || []).filter((x) => x.id !== "paused");
      options.style.setProperty("--rp-status-count", String(Math.max(statuses.length, 1)));
      for (const status of statuses) { const button = document.createElement("button"); button.type = "button"; button.dataset.rpStatus = status.id; button.textContent = status.label; button.classList.toggle("on", (item.status || "unread") === status.id); button.setAttribute("aria-pressed", String((item.status || "unread") === status.id)); options.append(button); }
    } catch (error) { box.querySelector("#rp-status-options").textContent = "無法載入狀態"; } /* i18n-dom: shared DOM translator localizes rendered UI text. */
    box.querySelector("#rp-map-generate").onclick = () => renderMindmap(box, true);
    box.querySelector("#rp-deep-generate").onclick = () => renderDeepAnalysis(box, true);
    const deepExpandBtn = box.querySelector("#rp-deep-expand");
    if (deepExpandBtn) deepExpandBtn.onclick = () => openDeepReportModal(lastGeneratedReport);

    const expandBtn = box.querySelector("#rp-map-expand");
    if (expandBtn) {
      expandBtn.onclick = () => {
        if (!lastGeneratedMindmap || !PR.mindmap) return;
        const mindData = PR.mindmap.parseToData(lastGeneratedMindmap.mermaid, paperTitle());
        PR.mindmap.openModal(mindData, {
          title: paperTitle(),
          onRegenerate: () => renderMindmap(box, true),
        });
      };
    }
    box.onclick = async (event) => {
      if (event.target.closest("[data-rp-map-retry]")) renderMindmap(box, true);
      if (event.target.closest("[data-rp-deep-retry]")) renderDeepAnalysis(box, true);
      const statusButton = event.target.closest("[data-rp-status]");
      if (statusButton) {
        const options = box.querySelector("#rp-status-options");
        if (options.dataset.busy || statusButton.classList.contains("on")) return;
        const previous = options.querySelector(".on")?.dataset.rpStatus || "unread", next = statusButton.dataset.rpStatus;
        options.dataset.busy = "1"; options.querySelectorAll("button").forEach((button) => { button.disabled = true; });
      box.querySelector("#rp-status-feedback").textContent = PR.t("正在儲存狀態…");
        try {
          await PR.api(API + "/item", { method: "POST", body: { id, status: next } });
          S.item = { ...S.item, status: next };
          options.querySelectorAll("button").forEach((button) => { const active = button.dataset.rpStatus === next; button.classList.toggle("on", active); button.setAttribute("aria-pressed", String(active)); });
          box.querySelector("#rp-status-feedback").textContent = PR.t("閱讀狀態已更新。");
        } catch (error) { box.querySelector("#rp-status-feedback").textContent = PR.t("狀態儲存失敗，請重試。"); PR.toast(PR.esc(error.message)); }
        finally { delete options.dataset.busy; options.querySelectorAll("button").forEach((button) => { button.disabled = false; }); }
        return;
      }
      const interested = event.target.closest("#rp-interested");
      if (interested) {
        const active = interested.getAttribute("aria-pressed") !== "true";
        if (interested.disabled) return;
        interested.disabled = true;
        interested.classList.add("is-saving");
        PR.api(API + "/item", { method: "POST", body: { id, interested: active, starred: active } }).then(() => {
          S.item = { ...S.item, interested: active, starred: active };
          interested.setAttribute("aria-pressed", String(active));
          interested.classList.toggle("is-interested", active);
          interested.setAttribute("aria-label", active ? "取消感興趣" : "標記感興趣"); interested.title = active ? "取消感興趣" : "標記感興趣"; /* i18n-dom: shared DOM translator localizes rendered UI text. */
          PR.toast(active ? PR.t("已標記感興趣，首頁與閱讀看板會同步更新。") : PR.t("已取消感興趣標記，首頁與閱讀看板會同步更新。"));
        }).catch((error) => {
          PR.toast(PR.esc(error.message));
        }).finally(() => { interested.disabled = false; interested.classList.remove("is-saving"); });
      }
    };
  }
  document.addEventListener("click", (event) => { if (event.target.closest("[data-rp-close]")) PR.toggleResearch(false); });

  if (typeof PR.on === "function") {
    PR.on("research-task-update", (status) => {
      const deepTask = status?.deepAnalysis;
      if (deepTask && (!deepTask.paper_id || deepTask.paper_id === PR.pid)) {
        const box = PR.$("#researchpanel");
        if (box && PR.researchOpen()) {
          const view = box.querySelector("#rp-deep-report");
          const button = box.querySelector("#rp-deep-generate");
          const expandBtn = box.querySelector("#rp-deep-expand");
          const defaultLabel = PR.t("產生／更新深度剖析報告");
          if (deepTask.state === "completed") {
            renderDeepAnalysis(box, false);
          } else if (deepTask.state === "failed" || deepTask.state === "interrupted") {
            if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
            if (view) view.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(deepTask.message || PR.t("分析未完成")) + '</span><button class="btn sm line" data-rp-deep-retry>' + PR.t("重試") + '</button></div>';
          } else if (deepTask.state === "cancelled") {
            if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
            renderDeepAnalysis(box, false);
          } else if (["queued", "running", "cancelling"].includes(deepTask.state)) {
            if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = PR.t("正在重新產生…"); }
            if (expandBtn) expandBtn.style.display = "none";
            if (view && !view.querySelector(".rp-map-loading")) {
              view.replaceChildren();
              view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.esc(deepTask.message || PR.t("正在依據論文內文進行技術審計…")) + '</span></div>';
            }
          }
        }
      }
      const task = status?.mindmap;
      if (!task) return;
      if (task.paper_id && task.paper_id !== PR.pid) return;
      const box = PR.$("#researchpanel");
      if (!box || !PR.researchOpen()) return;
      const view = box.querySelector("#rp-mindmap");
      const button = box.querySelector("#rp-map-generate");
      const expandBtn = box.querySelector("#rp-map-expand");
      const defaultLabel = PR.t("產生／更新心智圖");
      if (task.state === "completed") {
        renderMindmap(box, false);
      } else if (task.state === "failed" || task.state === "interrupted") {
        if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
        if (view) view.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(task.message || PR.t("分析未完成")) + '</span><button class="btn sm line" data-rp-map-retry>' + PR.t("重試") + '</button></div>';
      } else if (task.state === "cancelled") {
        if (button) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = defaultLabel; }
        renderMindmap(box, false);
      } else if (["queued", "running", "cancelling"].includes(task.state)) {
        if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = PR.t("正在重新產生…"); }
        if (expandBtn) expandBtn.style.display = "none";
        if (view && !view.querySelector(".rp-map-loading")) {
          view.replaceChildren();
          view.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.esc(task.message || PR.t("正在依據論文內文產生心智圖…")) + '</span></div>';
        }
      }
    });

    PR.on("open-research-mindmap", () => {
      PR.toggleResearch(true);
      const box = PR.$("#researchpanel");
      if (box) {
        const view = box.querySelector("#rp-mindmap");
        if (view) view.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });

    PR.on("retry-research-mindmap", () => {
      PR.toggleResearch(true);
      const box = PR.$("#researchpanel");
      if (box) renderMindmap(box, true);
    });

    PR.on("open-research-deep-analysis", () => {
      PR.toggleResearch(true);
      const box = PR.$("#researchpanel");
      if (box) {
        const view = box.querySelector("#rp-deep-report");
        if (view) view.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });

    PR.on("retry-research-deep-analysis", () => {
      PR.toggleResearch(true);
      const box = PR.$("#researchpanel");
      if (box) renderDeepAnalysis(box, true);
    });
  }

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("open") === "mindmap" || params.get("open") === "deep-analysis") {
      setTimeout(() => PR.toggleResearch(true), 300);
    }
  } catch (_) {}

})(window.PR);
