/* PaperRead: research discovery, candidates, and reading paths. */
(function (PR) {
  "use strict";
  const API = "/api/research/v2";
  const S = { items: [], saved: [], candidates: [], summaries: [], comparisons: [], statuses: [], categories: [], tab: "board", mode: "topic",
    results: [], authors: [], selectedAuthor: null, resultKind: "works", resultAuthor: "", relationRequest: null, hasMore: false, error: "", errorAction: "", checked: new Set(), page: 1, filters: { category: "", status: "", interested: false, pdf: "" }, sort: "added",
    venueQuery: "", venueOptions: [], venueSelected: [], venueWarning: "", venueBusy: false, resultFilters: null, exploreSort: "relevance_score:desc", yearFrom: "", yearTo: "", onlyOA: false, searchReason: "", filterExpanded: false,
    compareTask: null, compareProposal: null, comparePoll: "",
    compareSelection: new Set(), compareSetupOpen: false, boardExpanded: new Set(), pathGoalPreset: "foundations",
    pathResults: [], pathTopic: null, pathGoal: null, pathId: "", pathRevision: 0, pathModel: "", pathGeneratedAt: "", pathStartPaper: null,
    pathConfigOpen: false, pathRetryRequest: null, pathView: typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches ? "list" : "map", pathShowSequence: true, pathShowRelations: false,
    pathRelations: [], pathRelationError: "", pathRelationsLoading: false, pathSelectedKey: "", pathMapView: { scale: 1, panX: 0, panY: 0 }, pathSaveError: "", pathLatestLoaded: false, pathIncomingStart: null,
    compareDimensions: new Set(["研究問題", "核心方法", "資料集", "評估指標", "限制"]), // i18n-ok: 比較維度是送給後端的固定識別值。
    compareCustomDimension: "", compareFocus: "", comparePickerOpen: false, comparePickerCategory: "", comparePickerExpanded: false, quickPeekTaskId: "", quickPeekRecords: {}, keywords: [], keywordSelected: new Set(), keywordMode: "all", keywordManual: false, keywordArchived: false, keywordQuery: "", keywordMatches: [] };
  const RESEARCH_API = "/api/research/v1";
  const esc = PR.esc;
  const titleHtml = (value, fallback = "") => PR.titleHtml ? PR.titleHtml(value || fallback) : esc(value || fallback);
  function renderTitleNodes(root = document) {
    root.querySelectorAll(".rw-paper h3, .rw-relation-hero h3, h3.rw-quick-peek-title, .rw-path-card h3").forEach((node) => {
      if (node.querySelector(".katex")) return;
      const source = node.dataset.titleSource || node.textContent || "";
      node.dataset.titleSource = source;
      node.innerHTML = titleHtml(source);
    });
  }
  const $ = (sel, root) => PR.$(sel, root || document);
  const $$ = (sel, root) => PR.$$(sel, root || document);
  let quickPeekTrigger = null;
  const byId = (id) => S.items.find((x) => x.id === id);
  const normalizeItems = (items) => (items || []).map((item) => {
    const interested = Boolean(item.starred ?? item.interested);
    return { ...item, starred: interested, interested, status: item.status === "paused" ? "unread" : item.status };
  });
  const statusLabel = (id) => (S.statuses.find((s) => s.id === id) || S.statuses[0] || { label: "待閱讀" }).label; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
  const workId = (work) => {
    const m = String(work.openalex_id || work.id || "").match(/W\d+/);
    return m ? m[0] : "";
  };
  const normalizedTitle = (w) => String(w?.title || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const normalizeDoi = (value) => String(value || "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").split(/[?#]/, 1)[0].toLowerCase();
  const normalizeArxiv = (value) => String(value || "").trim().replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//i, "").replace(/^arxiv:/i, "").replace(/v\d+$/i, "").replace(/\.pdf$/i, "").toLowerCase();
  const canonicalOpenAlex = (value) => (String(value || "").match(/(?:openalex\.org\/)?(W\d+)\/?$/i) || [])[1]?.toUpperCase() || "";
  const paperKey = (w) => (w && (w.paper_key || w.key)) ? (w.paper_key || w.key) : w?.doi ? "doi:" + String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : w?.arxiv ? "arxiv:" + String(w.arxiv).replace(/v\d+$/i, "").toLowerCase() : workId(w || {}) ? "openalex:" + workId(w) : "title:" + normalizedTitle(w || {});
  const samePaper = (a, b) => {
    if (!a || !b) return false;
    if (a.doi && b.doi && normalizeDoi(a.doi) === normalizeDoi(b.doi)) return true;
    if (a.arxiv && b.arxiv && normalizeArxiv(a.arxiv) === normalizeArxiv(b.arxiv)) return true;
    const aOa = canonicalOpenAlex(a.openalex_id || a.id), bOa = canonicalOpenAlex(b.openalex_id || b.id);
    if (aOa && bOa && aOa === bOa) return true;
    const aTitle = normalizedTitle(a), bTitle = normalizedTitle(b);
    return paperKey(a) === paperKey(b) || (Boolean(aTitle) && aTitle === bTitle);
  };
  const candidateFor = (work) => S.candidates.find((c) => samePaper(c.paper, work));
  const savedFor = (work) => S.saved.find((item) => samePaper(item.metadata || {}, work));
  const dateText = (v) => v ? new Date(v + "T00:00:00").toLocaleDateString(PR.lang === "en" ? "en-US" : "zh-TW", { month: "numeric", day: "numeric" }) : "";
  const dayIso = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  const escAttr = (v) => esc(v).replace(/'/g, "&#39;");
  const btn = (label, action, cls = "line", attrs = "") => '<button class="btn sm ' + cls + '" data-action="' + action + '" ' + attrs + '>' + label + "</button>";
  const pathOrderButton = (key, direction, disabled) => {
    const label = direction < 0 ? PR.t("提前") : PR.t("延後");
    const arrow = direction < 0 ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4";
    return '<button type="button" class="btn sm line icon rw-path-order-btn" data-action="path-move-paper" data-path-key="' + escAttr(key) + '" data-direction="' + direction + '" aria-label="' + escAttr(label) + '" title="' + escAttr(label) + '"' + (disabled ? " disabled" : "") + '><svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + arrow + '"></path></svg><span class="rw-sr-only">' + label + '</span></button>';
  };
  function uniqueQueryTerms(lines) {
    const seen = new Set(), output = [];
    for (const token of lines.join(" ").split(/\s+/).filter(Boolean)) {
      const key = token.normalize("NFKC").toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!key || seen.has(key)) continue;
      seen.add(key); output.push(token);
    }
    return output.join(" ");
  }
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
  const relationTargetId = (work) => {
    const m = String(work?.openalex_id || work?.id || "").match(/W\d+/);
    if (m) return m[0];
    if (work?.doi) return "doi:" + normalizeDoi(work.doi);
    if (work?.arxiv) return "arxiv:" + normalizeArxiv(work.arxiv);
    return "";
  };
  function renderRelationHero() {
    if (!S.relation || !S.relationRequest) return "";
    const rel = S.relationRequest.relation || "related";
    const title = S.relationRequest.title || PR.t("指定論文");
    const relLabels = [
      { id: "related", label: PR.t("相關研究 (Related)") },
      { id: "cited-by", label: PR.t("被引用 (Citations)") },
      { id: "references", label: PR.t("參考文獻 (References)") },
    ];
    const tabs = relLabels.map((item) =>
      '<button type="button" class="btn sm ' + (rel === item.id ? "accent" : "line") + '" data-action="change-relation" data-relation="' + item.id + '"' + (rel === item.id ? ' aria-current="page"' : '') + '>' + item.label + '</button>'
    ).join(" ");

    const topicList = S.relationRequest.topics || [];
    const kwList = S.relationRequest.keywords || [];
    const aiKwList = S.relationRequest.aiKeywords || [];

    let pillsHtml = "";
    if (topicList.length || kwList.length || aiKwList.length) {
      const kwItems = [];
      if (aiKwList.length) {
        kwItems.push('<span class="rw-relation-kw-label">' + PR.t("AI 提煉：") + '</span>');
        for (const kw of aiKwList) {
          kwItems.push('<button type="button" class="rw-keyword-pill ai" data-action="apply-single-kw" data-kw="' + escAttr(kw) + '" title="' + PR.t("以「{kw}」搜尋相關論文", { kw: esc(kw) }) + '">✨ ' + esc(kw) + '</button>');
        }
      }
      if (topicList.length || kwList.length) {
        kwItems.push('<span class="rw-relation-kw-label">' + PR.t("推薦主題：") + '</span>');
        const standardList = [...topicList.slice(0, 3), ...kwList.slice(0, 5)];
        for (const kw of standardList) {
          kwItems.push('<button type="button" class="rw-keyword-pill" data-action="apply-single-kw" data-kw="' + escAttr(kw) + '" title="' + PR.t("以「{kw}」搜尋相關論文", { kw: esc(kw) }) + '">' + esc(kw) + '</button>');
        }
      }
      pillsHtml = '<div class="rw-relation-keywords">' + kwItems.join(" ") + '</div>';
    }

    const aiBtnLabel = S.aiDistillBusy
      ? '<i class="spin"></i> ' + PR.t("正在提煉…")
      : PR.t("AI 提煉主題關鍵字");
    const aiBtn = '<button type="button" class="btn sm line" data-action="ai-distill-keywords"' + (S.aiDistillBusy ? ' disabled aria-busy="true"' : '') + '>' + aiBtnLabel + '</button>';

    return '<section class="rw-relation-hero"><div class="rw-relation-hero-main"><span class="rw-chip oa">' + PR.t("以文探索研究") + '</span><h3>' + titleHtml(title) + '</h3><div class="rw-relation-tabs">' + tabs + '</div>' + pillsHtml + '</div><div class="rw-relation-hero-actions">' + aiBtn + '<button type="button" class="btn sm line" data-action="switch-to-topic-search">' + PR.t("改用關鍵字搜尋") + '</button></div></section>';
  }
  function pathGoalOptions() {
    return [
      { id: "foundations", label: PR.t("建立基礎概念"), description: PR.t("先補足背景、先備知識與入門論文。"), value: PR.t("建立基礎概念，先補足必要背景與先備知識。") },
      { id: "methods", label: PR.t("理解主流方法"), description: PR.t("掌握代表性架構、技術設計與方法演進。"), value: PR.t("理解主流方法，掌握代表性架構、技術設計與方法演進。") },
      { id: "paper", label: PR.t("深入目前論文"), description: PR.t("先補足這篇論文需要的背景，再延伸相關研究。"), value: PR.t("深入目前論文，先補足必要背景，再延伸閱讀相關研究。") },
      { id: "compare", label: PR.t("比較研究方法"), description: PR.t("安排不同方法、資料集與評估方式可比較的論文。"), value: PR.t("比較研究方法，聚焦方法、資料集與評估條件的差異。") },
      { id: "directions", label: PR.t("探索研究方向"), description: PR.t("關注最新研究、限制、研究缺口與延伸方向。"), value: PR.t("探索研究方向，關注最新成果、研究限制與可能的延伸方向。") }
    ];
  }

  async function init() {
    try {
      const lib = await PR.api("/api/library");
      PR.token = lib.token;
      const data = await PR.api(API);
      const keywordData = await PR.api(API + "/keywords");
      Object.assign(S, { items: normalizeItems(data.items), saved: data.saved || [], candidates: data.candidates || [], summaries: data.summaries || [], statuses: (data.statuses || []).filter((x) => x.id !== "paused"), categories: data.categories || [], keywords: keywordData.keywords || [] });
      if (S.tab === "path") {
        await loadLatestPath();
        const retryId = new URLSearchParams(location.search).get("retry_task");
        if (retryId) {
          const current = await PR.api(API + "/reading-path/tasks/current").catch(() => null);
          const request = current?.task?.id === retryId ? current.task.request : null;
          if (request) {
            S.pathRetryRequest = request;
            S.pathTopic = request.topic || ""; S.pathGoal = request.goal || ""; S.pathConfigOpen = true;
            const start = request.start_paper || {};
            const params = new URLSearchParams(location.search);
            if (start.title) params.set("start_title", start.title);
            if (start.doi) params.set("start_doi", start.doi);
            if (start.openalex_id) params.set("start_openalex", start.openalex_id);
            history.replaceState({}, "", "/research?" + params.toString());
          }
        }
      }
      paint();
      if (S.tab === "comparisons") {
        refreshComparisons().catch((error) => { S.comparisonError = error.message || String(error); renderComparisons(); });
      }
      if (S.tab === "explore") {
        if (S.relationTarget) {
          const { id, relation, title, doi } = S.relationTarget;
          await loadRelation(id, relation, title, doi);
        } else if (S.query) {
          await search();
        }
      }
      poll();
    } catch (e) {
      const alerts = $("#rw-alerts");
      if (alerts) alerts.innerHTML = '<div class="rw-error" role="alert">' + PR.t("無法載入研究工作區：{message}", { message: PR.t(e.message) }) + ' <a class="linkish" href="/research">' + PR.t("重試") + '</a></div>';
      const board = $("[data-view='board']");
      if (board) board.innerHTML = '<div class="rw-empty">' + PR.t("研究工作區暫時無法載入。") + '</div>';
    }
  }
  function poll() {
    clearTimeout(S.poll);
    S.poll = setTimeout(async () => {
      try {
        const lib = await PR.api("/api/library");
        const data = await PR.api(API);
        S.items = normalizeItems(lib.items || data.items); S.saved = data.saved || []; S.candidates = data.candidates || S.candidates; S.summaries = data.summaries || S.summaries;
        S.statuses = (data.statuses || S.statuses).filter((x) => x.id !== "paused");
        if ($(".rw-candidate-more[open]") || (document.activeElement?.closest(".rw-view") && document.activeElement.matches("input,select,textarea"))) S.pendingRender = true;
        else renderActive();
      } catch (_) { /* keep last known view while the local service reconnects */ }
      poll();
    }, 7000);
  }
  function paint() {
    $$(".rw-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    $$(".rw-view").forEach((v) => { v.hidden = v.dataset.view !== S.tab; });
    renderActive();
    $("[data-count='active']").textContent = allTasks().filter((i) => i.status !== "done").length || "";
    $("[data-count='candidates']").textContent = S.candidates.length || "";
    $("[data-count='summaries']").textContent = S.summaries.length || "";
  }
  function renderActive() {
    ({ explore: renderExplore, candidates: renderCandidates, summaries: renderSummaries, comparisons: renderComparisons, keywords: renderKeywords, board: renderBoard, path: renderPath }[S.tab] || renderExplore)();
    renderTitleNodes();
    $("[data-count='active']").textContent = allTasks().filter((i) => i.status !== "done").length || "";
    $("[data-count='candidates']").textContent = S.candidates.length || "";
    $("[data-count='summaries']").textContent = S.summaries.length || "";
  }
  function switchTab(tab) {
    if (tab !== "board") closeQuickPeek(false);
    S.tab = tab;
    $$(".rw-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $$(".rw-view").forEach((v) => { v.hidden = v.dataset.view !== tab; });
    if (tab === "path" && !S.pathLatestLoaded) loadLatestPath().finally(renderActive);
    else renderActive();
    if (tab === "comparisons") refreshComparisons();
    if (tab === "keywords") loadKeywords();
  }
  const KW_BUSY = ["queued", "running", "cancelling"];
  const kwSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const kwUid = (prefix) => prefix + "-" + (window.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  async function loadKeywords(startScan = true) {
    const [keywords] = await Promise.all([PR.api(API + "/keywords" + (S.keywordArchived ? "?archived=1" : ""))]);
    S.keywords = keywords.keywords || []; S.keywordNoText = keywords.no_text || [];
    const active = new Set(S.keywords.map((k) => k.id));
    S.keywordSelected = new Set([...S.keywordSelected].filter((id) => active.has(id)));
    if (!S.keywordArchived && S.keywordSelected.size) await loadKeywordMatches();
    else S.keywordMatches = [];
    renderKeywords();
    if (startScan && !(S.keywordScan?.task && KW_BUSY.includes(S.keywordScan.task.state))) startKeywordScan();
  }
  async function loadKeywordMatches() {
    const ids = [...S.keywordSelected];
    if (!ids.length) { S.keywordMatches = []; return; }
    const qs = new URLSearchParams({ ids: ids.join(","), mode: S.keywordMode, manual: S.keywordManual ? "1" : "0" });
    S.keywordMatches = (await PR.api(API + "/keywords/matches?" + qs)).matches || [];
  }
  function keywordScanHtml() {
    const scan = S.keywordScan || {}, task = scan.task;
    const retry = ' <button class="btn sm line" data-action="keyword-scan">' + PR.t("重試") + "</button>";
    if (scan.error) return esc(scan.error) + retry;
    if (!task) return "";
    if (KW_BUSY.includes(task.state)) return PR.t("原文比對中… {done}/{total}", { done: task.done || 0, total: task.total || 0 }) + ' <button class="btn sm line" data-action="keyword-scan-cancel">' + PR.t("取消") + "</button>";
    if (task.state === "completed") return PR.t("原文比對完成");
    return esc(task.state === "cancelled" ? PR.t("原文比對已取消") : (task.message || PR.t("原文比對失敗"))) + retry;
  }
  function updateKeywordScanStatus() { const el = $("[data-kw-scan-status]"); if (el) el.innerHTML = keywordScanHtml(); }
  async function startKeywordScan(keywordId = "") {
    try {
      S.keywordScan = { task: (await PR.api(API + "/keywords/scan/tasks", { method: "POST", body: keywordId ? { keyword_id: keywordId } : {} })).task, error: "" };
    } catch (error) { S.keywordScan = { task: null, error: error.message }; }
    updateKeywordScanStatus();
    pollKeywordScan();
  }
  async function pollKeywordScan() {
    if (S.keywordPolling) return;
    S.keywordPolling = true;
    try {
      while (S.keywordScan?.task && KW_BUSY.includes(S.keywordScan.task.state)) {
        await kwSleep(900);
        const res = await PR.api(API + "/keywords/scan/tasks/" + encodeURIComponent(S.keywordScan.task.id));
        if (!res.task) { S.keywordScan = { task: null, error: "" }; break; }
        S.keywordScan.task = res.task; updateKeywordScanStatus();
      }
    } catch (error) { S.keywordScan = { task: S.keywordScan?.task || null, error: error.message }; }
    finally { S.keywordPolling = false; }
    if (S.keywordScan?.task?.state === "completed") { try { await loadKeywords(false); } catch (error) { /* keep the previous list */ } }
    updateKeywordScanStatus();
  }
  function applyKeywordSearch() {
    const input = $("[data-keyword-search]"); if (!input) return;
    const q = input.value.trim().toLowerCase();
    $$(".rw-keyword-item").forEach((row) => { row.hidden = !!q && !String(row.dataset.kwText || "").includes(q); });
  }
  function highlightMatch(text, term) {
    if (!text) return "";
    if (!term || !term.trim()) return esc(text);
    const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp("(" + escaped + ")", "gi");
    const parts = text.split(regex);
    return parts.map((p, idx) => idx % 2 === 1 ? '<mark class="rw-kw-mark">' + esc(p) + "</mark>" : esc(p)).join("");
  }
  function renderKeywords() {
    const host = $("[data-view='keywords']"); if (!host) return;
    const selected = S.keywordSelected;
    const rows = S.keywords.map((k) => {
      const archived = Number(k.archived) === 1;
      const id = escAttr(k.id);
      return '<div class="rw-keyword-item" data-kw-text="' + escAttr((k.name + " " + k.match_text).toLowerCase()) + '">' +
        '<label class="rw-keyword-row">' +
          '<input type="checkbox" data-keyword-id="' + id + '"' + (selected.has(k.id) ? " checked" : "") + ">" +
          "<span><b>" + esc(k.name) + "</b><small>" + esc(k.match_text) + " · " + PR.t("{n} 篇論文", { n: k.papers || 0 }) + (archived ? " · " + PR.t("已封存") : "") + "</small></span>" +
        "</label>" +
        '<div class="rw-keyword-actions">' +
          (archived
            ? '<button class="btn sm line" data-action="keyword-restore" data-keyword-id="' + id + '">' + PR.t("恢復") + "</button>" +
              '<button class="btn sm line danger" data-action="keyword-delete" data-keyword-id="' + id + '">' + PR.t("移除") + "</button>"
            : '<button class="btn sm line" data-action="keyword-edit" data-keyword-id="' + id + '">' + PR.t("編輯") + "</button>" +
              '<button class="btn sm line" data-action="keyword-archive" data-keyword-id="' + id + '">' + PR.t("封存") + "</button>" +
              '<button class="btn sm line danger" data-action="keyword-delete" data-keyword-id="' + id + '">' + PR.t("移除") + "</button>") +
        "</div>" +
      "</div>";
    }).join("") || '<p class="rw-empty">' + PR.t("尚未收集關鍵字。可在閱讀器反白文字或從術語表加入。") + "</p>";

    const batchBar = selected.size > 0
      ? '<div class="rw-kw-batch-bar">' +
          '<span class="rw-kw-batch-count">' + PR.t("已選取 {n} 項", { n: selected.size }) + "</span>" +
          '<div class="rw-kw-batch-btns">' +
            (S.keywordArchived
              ? '<button class="btn sm line" data-action="keyword-batch-restore">' + PR.t("批次恢復") + "</button>"
              : '<button class="btn sm line" data-action="keyword-batch-archive">' + PR.t("批次封存") + "</button>") +
            '<button class="btn sm line danger" data-action="keyword-batch-delete">' + PR.t("批次移除") + "</button>" +
            '<button class="btn sm line" data-action="keyword-select-none">' + PR.t("取消全選") + "</button>" +
          "</div>" +
        "</div>"
      : (S.keywords.length > 0
          ? '<div class="rw-kw-batch-bar empty">' +
              '<span class="rw-kw-batch-count">' + PR.t("共 {n} 個關鍵字", { n: S.keywords.length }) + "</span>" +
              '<button class="btn sm line" data-action="keyword-select-all">' + PR.t("全選") + "</button>" +
            "</div>"
          : "");

    const matches = S.keywordMatches.map((m) => {
      const pid = escAttr(m.paper_id);
      const links = m.links || [];
      const kwCounts = {};
      links.forEach((l) => { kwCounts[l.name] = (kwCounts[l.name] || 0) + (l.occurrences || 1); });
      const pills = Object.entries(kwCounts).map(([kname, count]) =>
        '<span class="rw-kw-pill"><b>' + esc(kname) + "</b><small>" + PR.t("{n} 處", { n: count }) + "</small></span>"
      ).join("");

      const excerpts = links.map((l) => {
        const isAuto = l.source === "auto";
        const anchor = l.anchor ? "b-" + escAttr(l.anchor) : "";
        const pageInfo = l.page ? '<span class="rw-kw-page">' + PR.t("第 {page} 頁", { page: l.page }) + "</span>" : "";
        return '<div class="rw-kw-excerpt-card">' +
          '<div class="rw-kw-excerpt-meta">' +
            '<span class="rw-kw-tag">' + esc(l.name) + "</span>" +
            '<span class="rw-kw-source-type ' + escAttr(l.source) + '">' + (isAuto ? PR.t("自動比對") : PR.t("手動收錄")) + "</span>" +
            pageInfo +
          "</div>" +
          '<blockquote class="rw-kw-quote">' +
            highlightMatch(l.quote || PR.t("原文命中"), l.match_text) +
          "</blockquote>" +
          '<div class="rw-kw-excerpt-actions">' +
            '<a class="btn sm accent" href="/read/' + pid + (anchor ? "#" + anchor : "") + '">' +
              PR.t("開啟論文並定位到此段") + " ↗" +
            "</a>" +
          "</div>" +
        "</div>";
      }).join("");

      return '<article class="rw-card rw-kw-paper-card">' +
        '<div class="rw-kw-paper-head">' +
          '<h3><a href="/read/' + pid + '">' + titleHtml(m.title) + "</a></h3>" +
          '<div class="rw-kw-paper-stats">' +
            '<span class="rw-kw-total-badge">' + PR.t("共 {n} 處命中", { n: m.occurrences || links.length }) + "</span>" +
          "</div>" +
        "</div>" +
        (pills ? '<div class="rw-kw-pills">' + pills + "</div>" : "") +
        '<div class="rw-kw-excerpts-list">' + excerpts + "</div>" +
      "</article>";
    }).join("");

    host.innerHTML =
      '<div class="rw-section-head">' +
        "<div>" +
          "<h2>" + PR.t("跨論文關鍵字搜尋") + "</h2>" +
          '<p class="muted">' + PR.t("在全篇文獻庫中檢索關鍵字出現的段落，直接定位原文脈絡（僅限經 AI 翻譯整理內文後之論文方可比對檢索）。") + "</p>" +
        "</div>" +
      "</div>" +
      '<div class="rw-kw-layout">' +
        '<aside class="rw-kw-sidebar">' +
          '<div class="rw-panel rw-kw-box">' +
            '<div class="rw-kw-box-title">' + PR.t("關鍵字清單") + "</div>" +
            '<div class="rw-kw-add-row">' +
              '<input class="input" id="rw-kw-add-name" placeholder="' + escAttr(PR.t("關鍵字名稱")) + '" maxlength="120">' +
              '<input class="input" id="rw-kw-add-match" placeholder="' + escAttr(PR.t("原文比對詞")) + '" maxlength="180">' +
              '<button class="btn sm line" data-action="keyword-create">' + PR.t("新增") + "</button>" +
            "</div>" +
            '<div class="rw-toolbar" style="margin-top:10px">' +
              '<button class="btn sm ' + (S.keywordMode === "all" ? "accent" : "line") + '" data-action="keyword-mode" data-kw-mode="all">' + PR.t("符合全部") + "</button>" +
              '<button class="btn sm ' + (S.keywordMode === "any" ? "accent" : "line") + '" data-action="keyword-mode" data-kw-mode="any">' + PR.t("符合任一") + "</button>" +
              '<label class="rw-check"><input type="checkbox" data-keyword-manual' + (S.keywordManual ? " checked" : "") + ">" + PR.t("僅使用者收錄") + "</label>" +
              '<label class="rw-check"><input type="checkbox" data-keyword-archived' + (S.keywordArchived ? " checked" : "") + ">" + PR.t("顯示已封存") + "</label>" +
            "</div>" +
            '<div class="rw-toolbar" style="margin-top:8px">' +
              '<input class="rw-search" type="search" data-keyword-search placeholder="' + escAttr(PR.t("搜尋關鍵字…")) + '" aria-label="' + escAttr(PR.t("搜尋關鍵字")) + '" value="' + escAttr(S.keywordQuery || "") + '">' +
              '<span class="rw-source" data-kw-scan-status aria-live="polite">' + keywordScanHtml() + "</span>" +
            "</div>" +
            batchBar +
            '<div class="rw-kw-list">' + rows + "</div>" +
          "</div>" +
        "</aside>" +
        '<main class="rw-kw-main">' +
          (S.keywordArchived
            ? '<div class="rw-empty rw-kw-empty-prompt">' + PR.t("目前顯示已封存的關鍵字。可勾選項目進行「批次恢復」或「批次移除」。") + "</div>"
            : (selected.size
                ? (matches
                    ? '<div class="rw-kw-results-banner">' + PR.t("共找到 {n} 篇論文符合搜尋條件", { n: S.keywordMatches.length }) + '</div><div class="rw-kw-results">' + matches + "</div>"
                    : '<div class="rw-empty">' + PR.t("找不到符合目前條件的論文。可切換為「符合任一」或取消「僅使用者收錄」。") + "</div>")
                : '<div class="rw-empty rw-kw-empty-prompt">' + PR.t("請在左側勾選關鍵字以搜尋文獻庫論文。") + "</div>")) +
        "</main>" +
      "</div>";
    applyKeywordSearch();
  }
  document.addEventListener("input", (event) => { const field = event.target.closest && event.target.closest("[data-keyword-search]"); if (field) { S.keywordQuery = field.value; applyKeywordSearch(); } });
  function renderExplore() {
    const host = $("[data-view='explore']");
    const relationHero = renderRelationHero();
    const modeButtons = [["topic", "主題探索"], ["conference", "會議／期刊"]] // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      .map(([id, label]) => '<button data-mode="' + id + '" class="' + (S.mode === id ? "on" : "") + '">' + label + "</button>").join("");
    let extra = "";
    if (S.mode === "conference") extra = '<span class="rw-source">可輸入一個或多個來源，例如 ICCV、ECCV、CVPR。</span>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    let html = relationHero + '<div class="rw-panel"><form class="rw-toolbar" id="rw-search"><div class="rw-mode">' + modeButtons + '</div>' +
      '<input class="rw-search" id="rw-query" placeholder="' + (S.mode === "conference" ? "研究主題或關鍵字（可留空）" : "輸入研究概念或問題") + '" value="' + escAttr(S.query || "") + '">' + /* i18n-dom: shared DOM translator localizes rendered UI text. */
      '<input id="rw-year-from" type="number" min="1800" max="2100" aria-label="起始年份" placeholder="起始年" value="' + escAttr(S.yearFrom || "") + '" style="width:94px"><input id="rw-year-to" type="number" min="1800" max="2100" aria-label="結束年份" placeholder="結束年" value="' + escAttr(S.yearTo || "") + '" style="width:94px"><label class="rw-check"><input type="checkbox" id="rw-oa"' + (S.onlyOA ? " checked" : "") + '>有公開 PDF</label><select id="rw-sort"><option value="relevance_score:desc"' + (S.exploreSort === "relevance_score:desc" ? " selected" : "") + '>相關性</option><option value="publication_date:desc"' + (S.exploreSort === "publication_date:desc" ? " selected" : "") + '>最新</option><option value="cited_by_count:desc"' + (S.exploreSort === "cited_by_count:desc" ? " selected" : "") + '>引用數</option></select>' + /* i18n-dom: shared DOM translator localizes rendered UI text. */
       (S.mode === "topic" ? '<button class="btn line" type="button" data-action="ai-query">AI 產生搜尋關鍵字</button>' : '') + '<button class="btn accent" type="submit">搜尋</button></form>' + renderSourceFilter() + (S.mode === "conference" ? extra + '<div class="rw-source">' + PR.t("OpenAlex 書目資料可用於篩選出版來源；需核對正式出版狀態時，卡片會保留可查證的來源與 DOI 資訊。") + '</div>' : '<div class="rw-source">' + PR.t("主題搜尋以 OpenAlex 公開書目資料為基礎；引用關係的涵蓋範圍依資料來源而異。") + '</div>') + '</div>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    if (S.error) html += '<div class="rw-error">' + esc(S.error) + ' <button class="linkish" data-action="' + escAttr(S.errorAction || "retry-search") + '">重試</button></div>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    if (S.stale) html += '<div class="rw-stale"><span>' + PR.t("目前顯示上次成功取得的結果。") + '</span> ' + esc(S.staleError || "") + "</div>"; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    if (S.warning) html += '<div class="rw-stale">' + esc(S.warning) + "</div>"; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    if (S.loadingSearch) html += '<div class="rw-results" aria-live="polite">' + Array.from({ length: 6 }, () => '<article class="rw-card rw-paper rw-skeleton"><i></i><i></i><i></i></article>').join("") + '</div><p class="rw-source">正在查詢論文來源…</p>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    if (S.results.length) html += '<div class="rw-toolbar"><span class="rw-source">' + PR.t("合併後 {n} 篇", { n: S.resultCount == null ? S.results.length : S.resultCount }) + ' · ' + esc(S.checkedAt || "") + '</span><span class="grow"></span>' + Object.entries(S.providerStatus || {}).map(([name, status]) => '<span class="rw-provider ' + escAttr(status) + '">' + esc(name) + ': ' + PR.t(status === "loading" ? "查詢中" : status === "failed" ? "未連線" : "完成") + '</span>').join("") + '</div><div class="rw-results">' + S.results.map(workCard).join("") + "</div>" + (S.hasMore && S.page < 100 ? '<div class="rw-toolbar" style="justify-content:center;margin-top:16px">' + btn("載入更多論文", "next-page") + "</div>" : ""); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    else if (!S.error && !S.loadingSearch) html += '<div class="rw-empty">' + (S.searchReason === "not-found" ? "找不到此 DOI 或論文識別資料；請確認輸入內容，或改用標題關鍵字搜尋。" : "輸入研究概念開始探索論文。") + "</div>"; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    host.innerHTML = html;
  }
  function renderSourceFilter() {
    const selected = new Set(S.venueSelected.map((s) => s.id));
    const types = { conference: "會議", journal: "期刊", "book series": "書籍系列", repository: "典藏庫", "ebook platform": "電子書平台" }; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    const choices = S.venueOptions.map((s) => '<label class="rw-source-option"><input type="checkbox" data-source-choice="' + escAttr(s.id) + '"' + (selected.has(s.id) ? " checked" : "") + '><span>' + esc(s.name) + '<small>' + esc((s.matched_queries || []).join(" / ")) + ' · ' + esc(PR.t(types[s.type] || s.type || "來源類型未提供")) + ' · ' + esc(PR.t("OpenAlex 收錄 {n} 篇", { n: s.works_count == null ? PR.t("未提供") : s.works_count.toLocaleString() })) + '</small></span></label>').join(""); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    return '<div class="rw-source-filter"><label for="rw-venue-query">出版來源</label><input id="rw-venue-query" value="' + escAttr(S.venueQuery) + '" placeholder="ICCV、ECCV、CVPR"><button type="button" class="btn sm line" data-action="search-sources"' + (S.venueBusy ? " disabled" : "") + '>' + PR.t(S.venueBusy ? "正在查找…" : "加入出版來源") + '</button><span class="rw-source">' + PR.t("已選 {n} 個來源", { n: S.venueSelected.length }) + '</span>' + (S.venueSelected.length ? btn("清除選取", "clear-source", "line") : "") + '</div>' + (choices ? '<div class="rw-source-options">' + choices + '</div>' : "") + (S.venueWarning ? '<div class="rw-stale">' + esc(S.venueWarning) + '</div>' : ""); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
  }
  function alreadyInLibrary(w) {
    const saved = savedFor(w || {});
    if (saved?.library_id) {
      const linked = S.items.find((item) => item.id === saved.library_id);
      if (linked) return linked;
    }
    const doi = normalizeDoi(w?.doi), arxiv = normalizeArxiv(w?.arxiv);
    const openalex = canonicalOpenAlex(w?.openalex_id || w?.id);
    const key = paperKey(w || {});
    const exact = S.items.find((item) => {
      const itemDoi = normalizeDoi(item.doi), itemArxiv = normalizeArxiv(item.arxiv);
      const itemOpenAlex = canonicalOpenAlex(item.openalex_id);
      return (doi && itemDoi === doi) || (arxiv && itemArxiv === arxiv) ||
        (openalex && itemOpenAlex === openalex) || (key && item.paper_ref === key);
    });
    if (exact) return exact;

    // Imported metadata can be incomplete or normalized differently across sources.
    // Only fall back to a title match when it is unique and publication years do not conflict.
    const title = normalizedTitle({ title: w?.title || w?.title_en || w?.title_zh });
    if (!title) return undefined;
    const matches = S.items.filter((item) => {
      const itemTitle = normalizedTitle({ title: item.title_en || item.title_zh || item.short_zh });
      if (itemTitle !== title) return false;
      return !w?.year || !item.year || String(w.year) === String(item.year);
    });
    return matches.length === 1 ? matches[0] : undefined;
  }
  function workCard(w) {
    const key = paperKey(w), inCandidate = Boolean(candidateFor(w));
    const citations = w.cited_by_count == null ? PR.t("引用數未提供") : PR.t("引用 {n}", { n: Number(w.cited_by_count).toLocaleString() }); // i18n-ok: Research 工作區依產品規格固定使用繁體中文。
    const metadata = [w.authors, w.year, w.venue, citations].filter(Boolean).map(esc).join(" · ");
    const targetId = relationTargetId(w);
    const relationBtn = targetId ? btn(PR.t("關聯研究"), "explore-relation", "line", 'data-work="' + escAttr(targetId) + '" data-title="' + escAttr(w.title || "") + '" data-doi="' + escAttr(w.doi || "") + '"') : "";
    return '<article class="rw-card rw-paper"><h3>' + titleHtml(w.title) + '</h3><div class="meta">' + metadata + '</div><div>' + (w.pdf_url ? '<span class="rw-chip oa">有公開 PDF</span>' : w.is_oa ? '<span class="rw-chip">可公開取用，PDF 未確認</span>' : '<span class="rw-chip">公開 PDF 未確認</span>') + (w.publication_type ? '<span class="rw-chip">書目類型：' + esc(w.publication_type) + '</span>' : "") + (inCandidate ? '<span class="rw-chip">候選論文</span>' : "") + '</div><p class="abstract">' + esc(w.abstract || "來源未提供摘要。") + '</p>' + (w.recommendation_reason ? '<div class="rw-source"><span>' + PR.t("推薦依據：") + '</span> ' + esc(w.recommendation_reason) + '</div>' : "") + '<div class="rw-source"><span>' + PR.t("資料來源：") + '</span> ' + esc((w.sources || [w.source || "OpenAlex"]).join("、")) + ' · ' + esc(S.checkedAt || "") + '</div><div class="actions">' + btn(inCandidate ? "移出候選" : "加入候選", "candidate", inCandidate ? "line" : "accent", 'data-key="' + escAttr(key) + '"') + relationBtn + (w.url ? '<a class="btn sm line" target="_blank" rel="noopener" href="' + escAttr(w.url) + '">論文來源</a>' : "") + "</div></article>"; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
  }
  function renderCandidates() {
    const host = $("[data-view='candidates']"), records = S.candidates || [];
    host.innerHTML = '<div class="rw-section-head"><div><h2>候選論文</h2><p>' + PR.t("加入候選後會依來源摘要在背景整理摘要；全文比較需先加入閱讀看板並取得、整理 PDF。") + '</p></div><button class="btn line" data-tab="path">規劃閱讀路徑</button></div>' + /* i18n-dom: shared DOM translator localizes rendered UI text. */
      (records.length ? '<div class="rw-results">' + records.map((record) => {
        const w = record.paper || {}, paper = alreadyInLibrary(w), saved = savedFor(w), id = paper?.id || "";
        const summaryControl = record.summary_markdown
          ? btn(PR.t("查看摘要"), "view-summary", "accent", 'data-key="' + escAttr(record.paper_key) + '"')
          : record.summary_status === "failed"
            ? btn(PR.t("重試整理摘要"), "retry-summary", "line", 'data-key="' + escAttr(record.paper_key) + '"')
          : ["queued", "running"].includes(record.summary_status)
            ? "" : btn(PR.t("整理摘要"), "retry-summary", "line", 'data-key="' + escAttr(record.paper_key) + '"');
        const summaryStatus = !record.summary_markdown && ["queued", "running", "failed"].includes(record.summary_status)
          ? '<div class="rw-state" role="status">' + (record.summary_status === "failed"
            ? esc(PR.t("摘要整理失敗：{message}", { message: record.summary_error ? PR.t(record.summary_error) : PR.t("請重試。") }))
            : '<i class="spin"></i> ' + (record.summary_status === "running" ? PR.t("AI 正在整理摘要…") : PR.t("已加入背景摘要佇列…"))) + '</div>' : "";
        const moreActions = (record.summary_markdown
          ? btn(PR.t("下載"), "download-summary", "line", 'data-key="' + escAttr(record.paper_key) + '"')
            + btn(PR.t("匯入 Obsidian"), "export-summary-vault", "line", 'data-key="' + escAttr(record.paper_key) + '"')
            + btn(PR.t("重新整理摘要"), "candidate-summary", "line", 'data-key="' + escAttr(record.paper_key) + '" data-force-summary="1"') + '<hr>' : "")
          + btn(PR.t("移出候選"), "remove-candidate", "line", 'data-key="' + escAttr(record.paper_key) + '"');
        const pdfState = saved?.pdf_state || "";
        const fullTextStatus = paper
          ? PR.t("全文已匯入，正在整理中")
          : pdfState === "running" ? PR.t("PDF 下載／匯入中")
            : pdfState === "failed" ? PR.t("PDF 取得失敗")
              : pdfState === "pending" ? PR.t("等待取得 PDF")
                  : pdfState === "imported" ? PR.t("PDF 已匯入，但尚未連結到文獻項目")
                    : !saved ? PR.t("尚未加入閱讀看板")
                      : PR.t("尚未取得全文");
        const fullTextHelp = paper
          ? PR.t("論文 PDF 已匯入，但尚未完成全文整理。")
          : pdfState === "running" ? PR.t("正在下載並匯入 PDF，完成後即可開啟閱讀或比較。")
            : pdfState === "failed" ? PR.t("PDF 下載或匯入失敗；可到閱讀看板重試，或手動附加 PDF。") + (saved.pdf_error ? " " + PR.t(saved.pdf_error) : "")
              : pdfState === "pending" ? PR.t("已加入閱讀看板，PDF 尚在等待處理。")
                : pdfState === "imported" ? PR.t("PDF 已標記匯入，但找不到對應的文獻項目；請重新整理文獻庫確認。")
                  : PR.t("候選論文只有書目資料或來源摘要；加入閱讀看板並取得、整理 PDF 後，才能進行全文比較。");
        const fullTextBadge = '<span class="rw-chip rw-fulltext-state" title="' + escAttr(fullTextHelp) + '">' + esc(fullTextStatus) + '</span>';
        return '<article class="rw-card rw-paper"><div class="rw-candidate-titleline"><h3>' + titleHtml(w.title || "未命名論文") + '</h3>' + fullTextBadge + '</div><div class="meta">' + esc([w.authors, w.year, w.venue].filter(Boolean).join(" · ")) + '</div><p class="abstract">' + esc(w.abstract || "來源未提供摘要。") + '</p>' + (record.summary_markdown ? '<span class="rw-chip" title="' + escAttr(PR.t("此摘要根據搜尋來源提供的書目摘要整理，並不代表已取得論文全文。")) + '">' + PR.t("已整理來源摘要") + '</span>' : '') + summaryStatus + '<div class="actions rw-candidate-actions">' + summaryControl + (id ? '<a class="btn sm line" href="/read/' + escAttr(id) + '">' + PR.t("開啟閱讀") + '</a>' : btn(PR.t("加入閱讀看板"), "queue", "line", 'title="' + escAttr(PR.t("加入閱讀看板並取得 PDF")) + '" data-key="' + escAttr(record.paper_key) + '"')) + '<details class="rw-candidate-more"><summary class="btn sm line">' + PR.t("更多") + '</summary><div class="menu-list">' + moreActions + '</div></details>' + '</div></article>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
      }).join("") + '</div>' : '<div class="rw-empty">' + PR.t("候選清單目前是空的。先到研究探索搜尋，再按「加入候選」。") + '</div>'); /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  function renderSummaries() {
    const host = $("[data-view='summaries']"), records = S.summaries || [];
    host.innerHTML = '<div class="rw-section-head"><div><h2>已整理摘要</h2><p>整理結果會獨立保存；論文移出候選清單後，摘要仍會保留。</p></div></div>' + /* i18n-dom: shared DOM translator localizes rendered UI text. */
      (records.length ? '<div class="rw-results">' + records.map((record) => '<article class="rw-card rw-paper"><h3>' + titleHtml(record.paper.title || "未命名論文") + '</h3><div class="meta">' + esc([record.paper.authors, record.paper.year, record.paper.venue].filter(Boolean).join(" · ")) + '</div><span class="rw-chip">已整理摘要</span><div class="rw-source"><span>' + PR.t("整理模型：") + '</span>' + esc(record.summary_model || "未提供") + (record.updated ? ' · ' + esc(record.updated) : '') + '</div><div class="actions rw-candidate-actions">' + btn("查看摘要", "view-summary", "accent", 'data-key="' + escAttr(record.paper_key) + '"') + '<details class="rw-candidate-more"><summary class="btn sm line">' + PR.t("更多") + '</summary><div class="menu-list">' + btn("下載", "download-summary", "line", 'data-key="' + escAttr(record.paper_key) + '"') + btn("匯入 Obsidian", "export-summary-vault", "line", 'data-key="' + escAttr(record.paper_key) + '"') + btn("移到回收站", "trash-summary", "line", 'data-key="' + escAttr(record.paper_key) + '"') + '</div></details></div></article>').join("") + '</div>' : '<div class="rw-empty">' + PR.t("目前還沒有摘要。加入候選論文後會在背景自動整理摘要。") + '</div>'); /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  const compareDimensionOptions = ["研究問題", "核心方法", "資料集", "評估指標", "實驗條件", "成本", "限制"]; // i18n-ok: 比較維度是送給後端的固定識別值。
  function renderComparisonSetup() {
    const selected = [...S.compareSelection].map((id) => S.items.find((item) => item.id === id)).filter(Boolean);
    const missing = selected.filter((item) => Number(item.parsed_blocks || 0) <= 0);
    const dimensions = compareDimensionOptions.concat([...S.compareDimensions].filter((value) => !compareDimensionOptions.includes(value)));
    const papers = selected.length
      ? '<ul class="rw-compare-papers">' + selected.map((item) => '<li><b>' + titleHtml(item.title_zh || item.title_en || item.short_zh || item.id) + '</b><small>' + esc([item.year, item.venue].filter(Boolean).join(" · ")) + '</small></li>').join("") + '</ul>'
      : '<p class="rw-empty">' + PR.t("沒有找到選取的文獻，請返回文獻庫重新選擇。") + '</p>';
    const warning = missing.length ? '<p class="rw-stale">' + PR.t("以下論文尚未完成全文整理，無法開始比較：") + ' ' + esc(missing.map((item) => item.title_zh || item.title_en || item.id).join("、")) + '</p>' : ""; // i18n-ok: 論文標題分隔符。
    const checks = dimensions.map((value) => '<label><input type="checkbox" data-compare-dimension="' + escAttr(value) + '"' + (S.compareDimensions.has(value) ? ' checked' : '') + '> ' + PR.t(value) + '</label>').join("");
    const compareBusy = S.compareTask && ["queued", "running", "cancelling"].includes(S.compareTask.state);
    const canStart = selected.length >= 2 && selected.length <= 5 && !missing.length && S.compareDimensions.size > 0 && !compareBusy;
    return '<section class="rw-panel rw-compare-config"><div class="rw-section-head"><div><h3>' + PR.t("設定跨論文比較") + '</h3><p>' + PR.t("先選擇比較維度與分析焦點，確認後才會開始 AI 比較。") + '</p></div><button class="btn line" data-action="compare-cancel">' + PR.t("返回論文比較") + '</button></div>' +
      '<div class="rw-compare-select"><h3>' + PR.t("本次比較論文（{n} 篇）", { n: selected.length }) + '</h3>' + papers + '</div>' + warning +
      '<label class="rw-field"><span>' + PR.t("比較焦點（選填）") + '</span><input data-compare-focus value="' + escAttr(S.compareFocus) + '" placeholder="' + escAttr(PR.t("例如：各方法在資料效率上的差異")) + '"></label>' +
      '<div><h3>' + PR.t("比較維度") + '</h3><div class="rw-compare-dimensions">' + checks + '</div></div>' +
      '<div class="rw-compare-custom"><input data-compare-custom value="' + escAttr(S.compareCustomDimension) + '" placeholder="' + escAttr(PR.t("新增自訂維度")) + '"><button class="btn sm line" data-action="compare-add-dimension">' + PR.t("加入") + '</button></div>' +
      '<div class="actions"><button class="btn accent" data-action="compare-start"' + (canStart ? "" : " disabled") + '>' + PR.t("開始比較") + '</button></div></section>';
  }
  function comparePickerInitialLimit() {
    const columns = Math.floor(((window.innerWidth || 960) - 64) / 270);
    return Math.max(2, Math.min(5, columns || 2));
  }
  function comparePaperChoice(item, selected) {
    const title = item.title_zh || item.title_en || item.short_zh || item.id;
    const fullText = Number(item.parsed_blocks || 0) > 0;
    const fullTextLabel = fullText ? PR.t("全文已整理") : PR.t("尚未完成全文整理");
    return '<label class="rw-compare-paper-choice' + (fullText ? '' : ' is-disabled') + '"><input type="checkbox" data-compare-paper="' + escAttr(item.id) + '"' + (selected.has(item.id) ? ' checked' : '') + (fullText ? '' : ' disabled') + '><span><b>' + titleHtml(title) + '</b><small>' + esc([item.year, item.venue].filter(Boolean).join(' · ')) + ' · ' + fullTextLabel + '</small></span></label>';
  }
  function renderComparisonPicker() {
    const papers = S.items || [];
    const selected = S.compareSelection;
    const categories = [...new Set((S.categories || []).map((category) => String(category || "").trim()).filter(Boolean))];
    const uncategorizedCount = papers.filter((item) => !(item.tags || []).length).length;
    const categoryEntries = categories.map((name) => ({ key: name, label: name })).concat(uncategorizedCount ? [{ key: "__uncategorized__", label: PR.t("未分類") }] : []);
    const category = S.comparePickerCategory;
    const papersInCategory = category ? (category === "__uncategorized__" ? papers.filter((item) => !(item.tags || []).length) : papers.filter((item) => inCat(item, category))) : papers;
    const renderFolders = () => '<div class="rw-compare-picker-intro"><h3>' + PR.t("選擇論文分類") + '</h3><p>' + PR.t("先選擇分類，再從分類中的論文勾選要比較的項目。") + '</p></div><div class="rw-compare-folders">' + categoryEntries.map(({ key, label }) => {
      const count = key === "__uncategorized__" ? uncategorizedCount : papers.filter((item) => inCat(item, key)).length;
      return '<button type="button" class="rw-compare-folder" data-action="compare-picker-category" data-category="' + escAttr(key) + '" aria-label="' + escAttr(label + " " + count) + '"><svg class="rw-folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l1.8 2h9.2v9.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V6.5Z"></path><path d="M3.5 9h17"></path></svg><span><b>' + esc(label) + '</b><small>' + PR.t("{n} 篇文獻", { n: count }) + '</small></span></button>';
    }).join('') + '</div>';
    const renderPapers = () => {
      const limit = !category && !categories.length && !S.comparePickerExpanded ? comparePickerInitialLimit() : papersInCategory.length;
      const visible = papersInCategory.slice(0, limit);
      const choices = visible.length ? visible.map((item) => comparePaperChoice(item, selected)).join('') : '<p class="rw-empty">' + PR.t("文獻庫目前沒有可選的論文。") + '</p>';
      const more = !category && !categories.length && !S.comparePickerExpanded && papersInCategory.length > limit ? '<div class="actions rw-compare-more"><button class="btn line" data-action="compare-picker-more">' + PR.t("顯示更多論文") + '</button></div>' : '';
      const categoryLabel = category === "__uncategorized__" ? PR.t("未分類") : category;
      return (category ? '<div class="rw-compare-breadcrumb"><button type="button" class="btn line" data-action="compare-picker-back">' + PR.t("返回分類") + '</button><span>' + esc(categoryLabel) + ' (' + papersInCategory.length + ')</span></div>' : '<div class="rw-compare-picker-intro"><h3>' + PR.t("選擇論文") + '</h3><p>' + PR.t("文獻庫尚未建立分類，先從最近的論文中選取；需要時可再顯示更多。") + '</p></div>') + '<div class="rw-compare-paper-list">' + choices + '</div>' + more;
    };
    const content = categories.length && !category ? renderFolders() : renderPapers();
    const canContinue = selected.size >= 2 && selected.size <= 5;
    return '<section class="rw-panel rw-compare-picker"><div class="rw-section-head"><div><h3>' + PR.t('選擇比較論文') + '</h3><p>' + PR.t('直接在這裡選擇 2 至 5 篇已完成全文整理的論文，再設定比較維度。') + '</p></div><span class="rw-chip">' + PR.t('已選 {n} 篇', { n: selected.size }) + '</span></div>' + content + '<div class="actions"><button class="btn accent" data-action="compare-open-setup"' + (canContinue ? '' : ' disabled') + '>' + PR.t('下一步：設定比較') + '</button></div></section>';
  }
  function renderComparisons() {
    const host = $("[data-view='comparisons']"), records = S.comparisons || [];
    if (!host) return;
    if (S.comparisonsLoading) { host.innerHTML = '<div class="rw-empty"><i class="spin"></i> ' + PR.t("正在載入比較結果…") + '</div>'; return; }
    const error = S.comparisonError ? '<div class="rw-error" role="alert">' + esc(S.comparisonError) + ' <button class="btn sm line" data-action="comparisons-refresh">' + PR.t("重試") + '</button></div>' : '';
    const cards = records.map((record) => {
      const dateLabel = record.created ? new Date(record.created * 1000).toLocaleDateString(PR.lang === "en" ? "en-US" : "zh-TW") : PR.t("日期未提供");
      return '<article class="rw-card rw-paper"><div class="rw-section-head"><div><h3>' + titleHtml(record.title || PR.t("跨論文比較")) + '</h3><p class="meta">' + esc(dateLabel) + ' · ' + PR.t("{n} 篇論文", { n: record.paper_count || 0 }) + '</p></div></div><p>' + esc(record.status === "pending" ? PR.t("比較草稿尚待核對原文證據與評估條件。") : PR.t("可開啟這份比較結果檢視內容與證據。")) + '</p><div class="actions">' + btn(PR.t("查看比較結果"), "view-comparison", "accent", 'data-id="' + escAttr(record.id) + '"') + btn(PR.t("編輯名稱"), "edit-comparison-title", "line", 'data-id="' + escAttr(record.id) + '"') + (record.status === "accepted" ? btn(PR.t("下載"), "export-comparison-record", "line", 'data-id="' + escAttr(record.id) + '"') : '') + '</div></article>';
    }).join("");
    const task = S.compareTask;
    const active = task && ["queued", "running", "cancelling"].includes(task.state);
    const taskMarkup = active ? '<div class="rw-task-state" role="status"><i class="spin"></i><div><b>' + PR.t("正在整理跨論文比較…") + '</b><p>' + esc(task.message || PR.t("正在讀取已整理的全文，請稍候。")) + '</p>' + (task.total ? '<progress max="' + task.total + '" value="' + (task.done || 0) + '"></progress>' : '') + '</div></div>' : task?.state === "failed" ? '<div class="rw-error" role="alert">' + esc(task.message || PR.t("比較工作未完成。")) + ' <button class="btn sm line" data-action="comparisons-refresh">' + PR.t("重試") + '</button></div>' : '';
    host.innerHTML = '<div class="rw-section-head"><div><h2>' + PR.t("論文比較") + '</h2><p>' + PR.t("比較只從文獻庫已完成全文整理的論文開始；先設定比較維度，再產生可審閱的結果。") + '</p></div><div class="actions"><button class="btn line" data-action="compare-open-picker">' + PR.t("選擇比較論文") + '</button><button class="btn line" data-action="comparisons-refresh">' + PR.t("重新整理") + '</button></div></div>' + (S.compareSetupOpen ? renderComparisonSetup() : (S.comparePickerOpen ? renderComparisonPicker() : '')) + error + taskMarkup + (cards ? '<div class="rw-results">' + cards + '</div>' : (!active && !S.compareSetupOpen && !S.comparePickerOpen ? '<div class="rw-empty">' + PR.t("目前還沒有比較結果。請按「選擇比較論文」開始。") + '</div>' : ''));
  }
  async function startComparison(button) {
    const selected = [...S.compareSelection];
    const missing = selected.filter((id) => !S.items.find((item) => item.id === id && Number(item.parsed_blocks || 0) > 0));
    if (selected.length < 2 || selected.length > 5) return PR.toast(PR.t("跨論文比較需要選擇 2 至 5 篇論文。"));
    if (missing.length) return PR.toast(PR.t("所選論文都必須先完成 PDF 與全文整理，才能比較。"));
    if (!S.compareDimensions.size) return PR.toast(PR.t("請至少選擇一個比較維度。"));
    if (S.compareTask && ["queued", "running", "cancelling"].includes(S.compareTask.state)) return;
    if (!(await ensureVault())) return;
    if (button) { button.disabled = true; button.innerHTML = '<i class="spin"></i> ' + PR.t("正在開始…"); }
    try {
      S.comparisonError = "";
      S.compareTask = await PR.api(RESEARCH_API + "/comparison", { method: "POST", body: {
        paper_ids: selected, dimensions: [...S.compareDimensions], focus: S.compareFocus,
      } });
      PR.researchTaskMonitor?.track(S.compareTask, true);
      S.compareSetupOpen = false;
      S.compareSelection = new Set();
      history.replaceState({}, "", "/research?mode=comparisons");
      renderComparisons();
    } catch (error) {
      S.comparisonError = error.message || String(error);
      renderComparisons();
      PR.toast(PR.t(S.comparisonError));
    } finally { if (button?.isConnected) { button.disabled = false; button.textContent = PR.t("開始比較"); } }
  }
  async function refreshComparisons() {
    S.comparisonsLoading = true; S.comparisonError = ""; renderComparisons();
    try {
      const [results, status] = await Promise.all([PR.api(RESEARCH_API + "/comparisons"), PR.api("/api/research/v1/monitor")]);
      S.comparisons = results.comparisons || [];
      S.compareTask = (status.tasks || []).find((item) => item.kind === "comparison") || null;
      if (S.compareTask) PR.researchTaskMonitor?.track(S.compareTask);
    }
    catch (error) { S.comparisonError = error.message || String(error); }
    finally { S.comparisonsLoading = false; renderComparisons(); }
  }
  function applyPathSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.results)) return;
    S.pathResults = snapshot.results;
    S.pathTopic = snapshot.topic ?? S.pathTopic;
    S.pathGoal = snapshot.goal ?? S.pathGoal;
    S.pathStartPaper = snapshot.start_paper || null;
    S.pathId = snapshot.path_id || "";
    S.pathRevision = Number(snapshot.revision || 0);
    S.pathModel = snapshot.model || "";
    S.pathGeneratedAt = snapshot.updated_at || snapshot.created_at || "";
    S.pathRelations = Array.isArray(snapshot.relations) ? snapshot.relations : [];
    S.pathRelationError = snapshot.relations_error || "";
    S.pathSelectedKey = S.pathResults.some((step) => step.paper_key === S.pathSelectedKey) ? S.pathSelectedKey : (S.pathResults[0]?.paper_key || "");
  }
  async function loadLatestPath() {
    if (S.pathLatestLoaded) return;
    S.pathLatestLoaded = true;
    const query = new URLSearchParams(location.search);
    const incomingTitle = query.get("start_title") || query.get("title") || "";
    const incomingStart = incomingTitle ? { title: incomingTitle, doi: query.get("start_doi") || "", openalex_id: query.get("start_openalex") || "" } : null;
    const unsavedTopic = S.pathTopic, unsavedGoal = S.pathGoal;
    try {
      const data = await PR.api(API + "/reading-path/latest");
      if (data.path) {
        applyPathSnapshot(data.path);
        if (incomingStart && !samePaper(incomingStart, S.pathStartPaper || {})) {
          S.pathIncomingStart = incomingStart;
          S.pathTopic = unsavedTopic;
          S.pathGoal = unsavedGoal;
          S.pathConfigOpen = true;
        }
      }
    }
    catch (_) { S.pathSaveError = PR.t("無法讀取上次儲存的閱讀路徑。"); }
  }
  function pathConfig(startTitle, topic, goal, isFromPaper) {
    const goals = pathGoalOptions();
    const selectedPreset = goals.find((item) => item.value === goal)?.id || (S.pathGoalPreset === "custom" ? "" : S.pathGoalPreset);
    const goalCards = goals.map((item) => '<button type="button" role="radio" class="rw-path-goal' + (selectedPreset === item.id ? ' is-selected' : '') + '" data-action="select-path-goal" data-goal="' + escAttr(item.id) + '" aria-checked="' + (selectedPreset === item.id) + '"><strong>' + esc(item.label) + '</strong><small>' + esc(item.description) + '</small></button>').join("");
    const placeholder = isFromPaper ? PR.t("例如：Long Video Understanding（選填，直接以起點論文規劃可留空）") : PR.t("例如：Long Video Understanding");
    return '<section class="rw-panel rw-path-config"><h2>' + PR.t("規劃論文閱讀路徑") + '</h2><p class="rw-source">' + PR.t("以研究主題或目前論文為起點，AI 只會排序已取得的論文，並說明每篇的閱讀用途。") + '</p><div class="rw-form-grid"><label class="rw-field wide"><span>' + PR.t("研究主題") + '</span><input id="rw-path-topic" value="' + escAttr(topic) + '" placeholder="' + escAttr(placeholder) + '"></label>' + (startTitle ? '<div class="rw-field wide"><span>' + PR.t("起點論文") + '</span><strong>' + titleHtml(startTitle) + '</strong></div>' : '') + '<div class="rw-field wide"><span>' + PR.t("研究目標") + '</span><div class="rw-path-goal-grid" role="radiogroup" aria-label="' + escAttr(PR.t("選擇研究目標")) + '">' + goalCards + '</div><p class="rw-source">' + PR.t("選擇一個主要目標，AI 會依此安排閱讀順序。") + '</p></div><label class="rw-field wide"><span>' + PR.t("研究目標（可修改）") + '</span><textarea id="rw-path-goal" rows="2" placeholder="' + escAttr(PR.t("也可以直接輸入自訂研究目標")) + '">' + esc(goal) + '</textarea></label></div><button class="btn accent" data-action="generate-path"' + (S.pathLoading ? ' disabled' : '') + '>' + (S.pathLoading ? '<i class="spin"></i> ' + PR.t("AI 正在整理閱讀順序…") : PR.t("產生閱讀路徑")) + '</button></section>';
  }
  function pathDetail(step, index) {
    if (!step) return '<aside class="rw-path-detail rw-empty">' + PR.t("選取一篇論文以檢視完整資訊。") + '</aside>';
    const paper = step.paper || {}, key = step.paper_key || paperKey(paper), candidate = candidateFor(paper), library = alreadyInLibrary(paper);
    return '<aside class="rw-path-detail"><div class="rw-path-detail-kicker">' + PR.t("閱讀順序 {n}", { n: index + 1 }) + '</div><span class="rw-chip">' + esc(step.role || PR.t("延伸探索")) + '</span><h3>' + titleHtml(paper.title || PR.t("未命名論文")) + '</h3><p class="meta">' + esc([paper.authors, paper.year, paper.venue].filter(Boolean).join(" · ")) + '</p><h4>' + PR.t("推薦理由") + '</h4><p>' + esc(step.reason || PR.t("未提供推薦理由。")) + '</p><h4>' + PR.t("來源摘要") + '</h4><p class="rw-path-abstract">' + esc(paper.abstract || PR.t("來源未提供摘要。")) + '</p><p class="rw-source">' + PR.t("論文來源：{source}", { source: esc(paper.source || "OpenAlex") }) + '</p><div class="rw-path-detail-actions">' + btn(candidate ? PR.t("移出候選") : PR.t("加入候選"), "candidate", candidate ? "line" : "accent", 'data-key="' + escAttr(key) + '" data-paper-index="' + index + '"') + (library ? '<a class="btn sm line" href="/read/' + escAttr(library.id) + '">' + PR.t("開啟閱讀") + '</a>' : btn(PR.t("加入閱讀看板"), "queue", "line", 'data-key="' + escAttr(key) + '"')) + (paper.url ? '<a class="btn sm line" target="_blank" rel="noopener" href="' + escAttr(paper.url) + '">' + PR.t("論文來源") + '</a>' : '') + '</div><div class="rw-path-reorder"><span>' + PR.t("調整閱讀順序") + '</span><div class="rw-path-order-controls">' + pathOrderButton(key, -1, index === 0) + pathOrderButton(key, 1, index === S.pathResults.length - 1) + '</div></div></aside>';
  }
  function pathList() {
    return '<div class="rw-path-list">' + S.pathResults.map((step, index) => {
      const paper = step.paper || {}, key = step.paper_key || paperKey(paper);
      return '<article class="rw-card rw-path-card' + (key === S.pathSelectedKey ? ' is-selected' : '') + '"><button type="button" class="rw-path-index" data-action="path-select-paper" data-path-key="' + escAttr(key) + '">' + (index + 1) + '</button><div class="rw-path-card-content"><span class="rw-chip">' + esc(step.role || PR.t("延伸探索")) + '</span><h3>' + titleHtml(paper.title || PR.t("未命名論文")) + '</h3><p class="meta">' + esc([paper.year, paper.venue, paper.authors].filter(Boolean).join(" · ")) + '</p><p>' + esc(step.reason || PR.t("未提供推薦理由。")) + '</p><div class="rw-path-card-actions"><div class="actions">' + btn(PR.t("檢視詳情"), "path-select-paper", "line", 'data-path-key="' + escAttr(key) + '"') + '</div><div class="rw-path-order-controls">' + pathOrderButton(key, -1, index === 0) + pathOrderButton(key, 1, index === S.pathResults.length - 1) + '</div></div></div></article>';
    }).join("") + '</div>';
  }
  function renderPath() {
    const host = $("[data-view='path']"), query = new URLSearchParams(location.search);
    const incomingTitle = query.get("start_title") || query.get("title") || "";
    const isFromPaper = Boolean(incomingTitle);
    if (isFromPaper && !S.pathGoal && S.pathGoalPreset === "foundations") S.pathGoalPreset = "paper";
    const rawQ = query.get("q") || "";
    const cleanQ = cleanTopicQuery(rawQ);
    const cleanIncoming = cleanTopicQuery(incomingTitle);
    const topic = S.pathTopic ?? (isFromPaper && (rawQ === incomingTitle || cleanQ === cleanIncoming || !rawQ) ? "" : (cleanQ || rawQ));
    const fallback = pathGoalOptions().find((item) => item.id === S.pathGoalPreset) || pathGoalOptions()[0];
    const goal = S.pathGoal ?? fallback.value;
    const config = pathConfig(incomingTitle, topic, goal, isFromPaper);
    if (!S.pathResults.length) { host.innerHTML = config + (S.pathError ? '<div class="rw-error">' + esc(S.pathError) + ' ' + btn(PR.t("重試"), "generate-path") + '</div>' : ""); return; }
    const selectedIndex = Math.max(0, S.pathResults.findIndex((step) => step.paper_key === S.pathSelectedKey));
    const selected = S.pathResults[selectedIndex] || S.pathResults[0];
    const toolbar = '<div class="rw-path-toolbar"><div class="rw-path-view-switch" role="group" aria-label="' + escAttr(PR.t("閱讀路徑顯示方式")) + '"><button type="button" class="btn sm ' + (S.pathView === "map" ? "accent" : "line") + '" data-action="path-view" data-path-view="map" aria-pressed="' + (S.pathView === "map") + '">' + PR.t("地圖") + '</button><button type="button" class="btn sm ' + (S.pathView === "list" ? "accent" : "line") + '" data-action="path-view" data-path-view="list" aria-pressed="' + (S.pathView === "list") + '">' + PR.t("清單") + '</button></div><div class="rw-path-toggle-group"><button type="button" class="btn sm line" data-action="path-toggle-sequence" aria-pressed="' + S.pathShowSequence + '">' + PR.t("閱讀順序") + '</button><button type="button" class="btn sm line" data-action="path-toggle-relations" aria-pressed="' + S.pathShowRelations + '"' + (S.pathRelationsLoading ? " disabled" : "") + '>' + (S.pathRelationsLoading ? PR.t("正在更新引用…") : PR.t("引用關係")) + '</button>' + (S.pathShowRelations ? btn(PR.t("更新引用資料"), "path-refresh-relations", "line") : "") + '</div><div class="rw-path-zoom"><button type="button" class="btn sm line" data-action="path-zoom" data-zoom="out" aria-label="' + escAttr(PR.t("縮小")) + '">−</button><button type="button" class="btn sm line" data-action="path-zoom" data-zoom="in" aria-label="' + escAttr(PR.t("放大")) + '">＋</button><button type="button" class="btn sm line" data-action="path-fit">' + PR.t("符合視窗") + '</button></div></div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    const meta = '<section class="rw-path-summary"><div><span>' + PR.t("研究主題") + '</span><strong>' + (topic ? titleHtml(topic) : (S.pathStartPaper?.title ? titleHtml(S.pathStartPaper.title) : (incomingTitle ? titleHtml(incomingTitle) : esc(PR.t("未命名主題"))))) + '</strong></div><div><span>' + PR.t("研究目標") + '</span><strong>' + esc(goal) + '</strong></div><button type="button" class="btn sm line" data-action="path-toggle-settings" aria-expanded="' + S.pathConfigOpen + '">' + PR.t("修改設定") + '</button></section>';
    const map = globalThis.PRPathMap?.render({ steps: S.pathResults, selectedKey: selected.paper_key, showSequence: S.pathShowSequence, showRelations: S.pathShowRelations, relations: S.pathRelations, view: S.pathMapView, esc, titleHtml, libraryFor: (paper) => { const item = alreadyInLibrary(paper); return item ? PR.t(statusLabel(item.status || "unread")) : ""; }, labels: { start: PR.t("起點論文"), paper: PR.t("論文"), mapLabel: PR.t("閱讀路徑地圖"), mapHelp: PR.t("拖曳空白處平移地圖；可使用工具列縮放與符合視窗。") } }) || "";
    const relationNotice = S.pathShowRelations && S.pathRelationError ? '<div class="rw-path-notice">' + esc(S.pathRelationError) + ' ' + btn(PR.t("重試"), "path-refresh-relations", "line") + '</div>' : (S.pathShowRelations && !S.pathRelationsLoading && !S.pathRelations.length ? '<div class="rw-path-notice">' + PR.t("目前資料未找到圖內引用關係。") + '</div>' : "");
    const savedPathNotice = S.pathIncomingStart ? '<div class="rw-path-notice">' + PR.t("正在顯示上次儲存的閱讀路徑；請依目前起點論文修改設定後重新產生。") + '</div>' : "";
    host.innerHTML = (S.pathConfigOpen ? config : meta) + savedPathNotice + (S.pathSaveError ? '<div class="rw-error">' + esc(S.pathSaveError) + '</div>' : "") + (S.pathError ? '<div class="rw-error">' + esc(S.pathError) + ' ' + btn(PR.t("重試"), "generate-path") + '</div>' : "") + toolbar + '<div class="rw-path-legend"><span><i class="rw-path-legend-sequence"></i>' + PR.t("虛線：建議閱讀順序") + '</span><span><i class="rw-path-legend-citation"></i>' + PR.t("實線：引用者指向被引用論文") + '</span></div>' + relationNotice + (S.pathView === "map" ? '<div class="rw-path-layout">' + map + pathDetail(selected, selectedIndex) + '</div>' : '<div class="rw-path-list-layout">' + pathList() + pathDetail(selected, selectedIndex) + '</div>');
    if (S.pathView === "map" && globalThis.PRPathMap) globalThis.PRPathMap.bind(host, S.pathMapView, (view) => { S.pathMapView = view; });
  }
  function savedTask(s) { return { id: "saved:" + s.paper_key, saved_key: s.paper_key, paper_ref: s.paper_key, title: s.metadata.title, authors: s.metadata.authors, year: s.metadata.year, status: s.status, tags: s.categories || (s.category ? [s.category] : []), interested: s.interested, starred: s.interested, archived: Boolean(s.archived), pdf_state: s.pdf_state, pdf_error: s.pdf_error, progress: 0, manual_order: s.manual_order || 0, added: s.created || s.updated || "", saved: true, metadata: s.metadata }; }
  const taskRef = (item) => "paper:" + (item.saved_key || item.paper_ref || item.id);
  const inCat = (item, cat) => (item.tags || []).some((t) => t === cat || String(t).startsWith(cat + "/"));
  function allTasks() { return [...S.items.filter((x) => !x.archived), ...S.saved.filter((x) => x.pdf_state !== "imported" && !x.archived).map(savedTask)]; }
  function renderBoard() {
    const host = $("[data-view='board']"), all = allTasks();
    const category = S.filters.category, status = S.filters.status;
    let list = all.filter((i) => (!category || inCat(i, category)) && (!status || i.status === status) && (!S.filters.interested || i.interested) && (!S.filters.pdf || (S.filters.pdf === "missing" ? i.saved || !(i.pages > 0) : i.pages > 0)));
    if (S.sort === "recent") list.sort((a,b) => String(b.last_opened || b.added || "").localeCompare(String(a.last_opened || a.added || "")));
    else if (S.sort === "manual") list.sort((a,b) => Number(a.manual_order || 0) - Number(b.manual_order || 0) || String(b.added || "").localeCompare(String(a.added || "")));
    else list.sort((a,b) => String(b.added || "").localeCompare(String(a.added || "")));
    S.boardVisible = list;
    const columns = S.statuses.map((s) => {
      const columnItems = list.filter((x) => (x.status || "unread") === s.id);
      const expanded = S.boardExpanded.has(s.id);
      const visibleItems = expanded ? columnItems : columnItems.slice(0, 8);
      const more = columnItems.length > 8 ? '<button type="button" class="rw-column-more" data-action="toggle-column" data-column="' + escAttr(s.id) + '" aria-expanded="' + expanded + '">' + (expanded ? PR.t("收起") : PR.t("顯示全部（{n} 篇）", { n: columnItems.length })) + '</button>' : '';
      return '<section class="rw-column" data-column="' + escAttr(s.id) + '" style="--col:' + escAttr(s.color) + '"><div class="rw-column-head"><i class="dot"></i><span class="rw-column-label">' + esc(s.label) + '</span><span class="n">' + columnItems.length + '</span><button class="linkish" data-action="add-column" title="' + escAttr(PR.t("新增狀態")) + '">+</button></div><div class="rw-column-list">' + (visibleItems.length ? visibleItems.map(taskCard).join("") : '<div class="rw-column-empty">' + PR.t("目前沒有論文") + '</div>') + '</div>' + more + '</section>';
    }).join(""); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    const activeFilter = Boolean(category || status || S.filters.interested || S.filters.pdf);
    const activeLabels = [category && category, status && PR.t(statusLabel(status)), S.filters.pdf && PR.t(S.filters.pdf === "missing" ? "待補 PDF" : "已有 PDF"), S.filters.interested && PR.t("感興趣")].filter(Boolean); /* i18n-dom: shared DOM translator localizes rendered UI text. */
    host.innerHTML = '<div class="rw-board-tools"><details class="rw-filter-details"' + (S.filterExpanded ? " open" : "") + '><summary><span class="rw-filter-title">篩選條件</span>' + (activeLabels.length ? '<span class="rw-filter-count">' + activeLabels.length + ' 項已套用</span><span class="rw-filter-active">' + activeLabels.map(esc).join(" · ") + '</span>' : '<span class="rw-filter-active">依分類、狀態、PDF 或感興趣篩選</span>') + '<span class="rw-filter-chevron" aria-hidden="true">⌄</span></summary><div class="rw-filter-content"><label class="rw-filter-field"><span>分類</span><select data-filter="category" aria-label="依分類篩選"><option value="">所有分類</option>' + S.categories.map((c) => '<option value="' + escAttr(c) + '"' + (category === c ? " selected" : "") + '>' + esc(c) + '</option>').join("") + '</select></label><label class="rw-filter-field"><span>閱讀狀態</span><select data-filter="status" aria-label="依閱讀狀態篩選"><option value="">所有狀態</option>' + S.statuses.map((s) => '<option value="' + escAttr(s.id) + '"' + (status === s.id ? " selected" : "") + '>' + esc(s.label) + '</option>').join("") + '</select></label><label class="rw-filter-field"><span>PDF</span><select data-filter="pdf" aria-label="依 PDF 狀態篩選"><option value="">PDF 狀態不限</option><option value="missing"' + (S.filters.pdf === "missing" ? " selected" : "") + '>待補 PDF</option><option value="ready"' + (S.filters.pdf === "ready" ? " selected" : "") + '>已有 PDF</option></select></label><button type="button" class="rw-filter-chip' + (S.filters.interested ? ' on' : '') + '" data-action="toggle-interested-filter" aria-pressed="' + S.filters.interested + '"><span aria-hidden="true">★</span> ' + PR.t("感興趣") + '</button><label class="rw-filter-field rw-sort-field"><span>排序</span><select data-sort><option value="added"' + (S.sort === "added" ? " selected" : "") + '>最新加入</option><option value="recent"' + (S.sort === "recent" ? " selected" : "") + '>最近閱讀</option><option value="manual"' + (S.sort === "manual" ? " selected" : "") + '>手動優先序</option></select></label>' + (activeFilter ? btn("清除篩選", "clear-filters", "line") : "") + '</div></details>' + btn("管理狀態", "manage-status", "line") + '</div><div class="rw-board">' + (columns || "") + '</div>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    host.querySelector(".rw-filter-details").addEventListener("toggle", (event) => { S.filterExpanded = event.currentTarget.open; });
    if (!list.length) host.innerHTML += '<div class="rw-empty">看板目前沒有符合條件的論文。' + btn("從論文探索加入", "go-explore") + '</div>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    if (S.quickPeekTaskId && !all.some((item) => item.id === S.quickPeekTaskId)) closeQuickPeek(false);
    else if (S.quickPeekTaskId) renderQuickPeek();
  }
  function taskCard(i) {
    const percent = Math.round(Math.max(0, Math.min(1, Number(i.progress || 0))) * 100);
    const categories = (i.tags || []).join("、"); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    const title = i.saved ? i.title : (i.title_zh || i.title_en || "未命名論文"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
    const accessibleLabel = PR.t("論文：{title}。閱讀狀態：{status}。可拖曳移動；也可按 Alt 加左右方向鍵變更狀態。", { title, status: PR.t(statusLabel(i.status || "unread")) }) + PR.t("按 Enter 開啟快速檢視。");
    return '<article class="rw-task" draggable="true" tabindex="0" aria-keyshortcuts="Enter Alt+ArrowLeft Alt+ArrowRight" aria-expanded="' + (S.quickPeekTaskId === i.id) + '" aria-label="' + escAttr(accessibleLabel) + '" data-task="' + escAttr(i.id) + '" data-saved="' + (i.saved ? "1" : "0") + '"><h3>' + (i.saved ? titleHtml(i.title) : '<a href="/read/' + escAttr(i.id) + '">' + titleHtml(title) + '</a>') + '</h3><div class="muted rw-task-authors" title="' + escAttr(i.authors || "作者未提供") + '">' + esc(i.authors || "作者未提供") + (i.year ? " · " + esc(i.year) : "") + '</div>' + (categories ? '<div class="muted rw-task-category" title="' + escAttr(categories) + '"><span>' + PR.t("分類：") + '</span> ' + esc(categories) + '</div>' : "") + (i.saved ? '<div class="muted rw-task-pdf">' + (i.pdf_state === "failed" ? "待補 PDF" : i.pdf_state === "running" ? "正在下載 PDF" : "等待 PDF") + '</div>' : '<div class="rw-progress" title="' + escAttr(PR.t("閱讀進度 {n}%", { n: percent })) + '"><i style="width:' + percent + '%"></i></div><div class="muted rw-task-progress">' + PR.t("閱讀進度 {n}%", { n: percent }) + '</div>') + '<div class="task-line">' + (i.saved ? '<button class="linkish" data-action="attach-pdf" data-key="' + escAttr(i.saved_key) + '">附加 PDF</button>' : '') + (i.saved && i.pdf_state === "failed" ? '<button class="linkish" data-action="retry-pdf" data-key="' + escAttr(i.saved_key) + '">重試 PDF</button>' : '') + '<button class="linkish interest-star' + (i.interested ? ' is-interested' : '') + '" aria-label="' + escAttr(PR.t(i.interested ? "取消感興趣" : "標記感興趣")) + '" title="' + escAttr(PR.t(i.interested ? "取消感興趣" : "標記感興趣")) + '" data-action="interested" data-task-id="' + escAttr(i.id) + '"' + (i.saved ? ' data-saved-key="' + escAttr(i.saved_key) + '"' : "") + '>' + (i.interested ? "★" : "☆") + '</button><button class="linkish archive-btn" aria-label="' + escAttr(PR.t("封存論文")) + '" title="' + escAttr(PR.t("封存論文")) + '" data-action="archive-task" data-task-id="' + escAttr(i.id) + '"' + (i.saved ? ' data-saved-key="' + escAttr(i.saved_key) + '"' : "") + '>' + PR.icon("archive", "sm") + '</button></div></article>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
  }
  function quickPeekPdfState(task) {
    if (!task.saved) return PR.t("PDF 可供閱讀");
    if (task.pdf_state === "failed") return PR.t("PDF 處理失敗");
    if (task.pdf_state === "running") return PR.t("PDF 正在取得");
    return PR.t("PDF 尚待取得");
  }
  function quickPeekSummary(task) {
    const keys = [task.paper_ref, task.saved_key, paperKey(task)].filter(Boolean);
    return S.summaries.find((x) => keys.includes(x.paper_key)) || S.candidates.find((x) => keys.includes(x.paper_key)) || null;
  }
  function quickPeekRecordHref(task, anchor) {
    if (task.saved) return "";
    return "/read/" + encodeURIComponent(task.id) + (anchor && anchor !== "head" ? "#b-" + encodeURIComponent(anchor) : "");
  }
  function quickPeekRecordLink(task, record, text, label) {
    const href = quickPeekRecordHref(task, record.anchor);
    const body = '<span class="rw-quick-peek-record-label">' + esc(label) + '</span><span>' + esc(text || PR.t("未提供內容")) + '</span>';
    return href ? '<a class="rw-quick-peek-record" href="' + escAttr(href) + '">' + body + '</a>' : '<div class="rw-quick-peek-record">' + body + '</div>';
  }
  function quickPeekRecordsHtml(task) {
    const record = S.quickPeekRecords[task.id];
    if (!record) return '<p class="rw-source">' + (task.saved ? PR.t("PDF 尚待取得") : PR.t("正在載入閱讀紀錄…")) + '</p>';
    if (record.error) return '<p class="rw-source">' + esc(PR.t("無法載入閱讀紀錄。")) + '</p>';
    const notes = record.notes || [], highlights = record.highlights || [], questions = record.questions || [];
    const list = (title, empty, values, getText, label) => '<div class="rw-quick-peek-record-group"><h4>' + title + '</h4>' + (values.length ? values.map((item) => quickPeekRecordLink(task, item, getText(item), label)).join("") : '<p class="rw-source">' + empty + '</p>') + '</div>';
    return list(PR.t("最近筆記"), PR.t("沒有最近筆記。"), notes, (n) => n.body, PR.t("我的筆記")) + list(PR.t("最近劃線"), PR.t("沒有最近劃線。"), highlights, (n) => n.quote, PR.t("我的劃線")) + list(PR.t("最近問題"), PR.t("沒有最近問題。"), questions, (n) => n.body, PR.t("我的問題"));
  }
  async function loadQuickPeekRecords(task) {
    if (task.saved || S.quickPeekRecords[task.id]?.loading || S.quickPeekRecords[task.id]?.loaded) return;
    S.quickPeekRecords[task.id] = { loading: true };
    renderQuickPeek();
    try {
      const state = await PR.api("/api/p/" + encodeURIComponent(task.id) + "/state");
      const notes = Object.values(state.reader?.notes || {}).filter((n) => !n.deleted);
      const recent = notes.slice().sort((a, b) => String(b.updated || b.created || "").localeCompare(String(a.updated || a.created || "")));
      S.quickPeekRecords[task.id] = { loaded: true, notes: recent.filter((n) => n.kind !== "highlight" && n.kind !== "question").slice(0, 3), highlights: recent.filter((n) => n.kind === "highlight").slice(0, 3), questions: recent.filter((n) => n.kind === "question").slice(0, 3) };
    } catch (_) { S.quickPeekRecords[task.id] = { loaded: true, error: true }; }
    if (S.quickPeekTaskId === task.id) renderQuickPeek();
  }
  function quickPeekAdjacent(direction) {
    const items = S.boardVisible || allTasks();
    const index = items.findIndex((item) => item.id === S.quickPeekTaskId);
    const next = items[index + direction];
    if (next) openQuickPeek(next.id);
  }
  function quickPeekEditor(task) {
    const categories = S.categories.map((category) => '<button type="button" class="rw-quick-peek-toggle' + ((task.tags || []).includes(category) ? ' on' : '') + '" data-action="quick-peek-category" data-category="' + escAttr(category) + '" aria-pressed="' + ((task.tags || []).includes(category)) + '">' + esc(category) + '</button>').join("");
    const statuses = S.statuses.map((item) => '<button type="button" class="rw-quick-peek-toggle' + (item.id === task.status ? ' on' : '') + '" data-action="quick-peek-status" data-status="' + escAttr(item.id) + '" aria-pressed="' + (item.id === task.status) + '">' + esc(item.label) + '</button>').join("");
    const starLabel = task.interested ? PR.t("取消感興趣") : PR.t("標記感興趣");
    return '<div class="rw-quick-peek-edit"><p class="rw-label">' + PR.t("閱讀狀態") + '</p><div class="rw-quick-peek-toggles">' + statuses + '</div><p class="rw-label">' + PR.t("分類") + '</p><div class="rw-quick-peek-toggles">' + (categories || '<span class="rw-source">' + PR.t("未附加分類") + '</span>') + '</div><button type="button" class="rw-quick-peek-star' + (task.interested ? ' on' : '') + '" data-action="quick-peek-star" aria-pressed="' + Boolean(task.interested) + '">' + (task.interested ? "★" : "☆") + ' ' + starLabel + '</button></div>';
  }
  function renderQuickPeek() {
    const drawer = $("#rw-quick-peek"), scrim = $("#rw-quick-peek-scrim");
    if (!drawer || !scrim) return;
    const task = allTasks().find((item) => item.id === S.quickPeekTaskId);
    if (!task || S.tab !== "board") {
      drawer.classList.remove("is-open"); drawer.setAttribute("aria-hidden", "true"); drawer.innerHTML = "";
      scrim.classList.remove("is-open");
      return;
    }
    const title = task.saved ? task.title : (task.title_zh || task.title_en || PR.t("未命名論文"));
    const authors = task.authors || task.metadata?.authors || PR.t("作者未提供");
    const summaryRecord = quickPeekSummary(task);
    const summary = summaryRecord?.summary_markdown || task.summary_markdown || task.summary || "";
    const abstract = task.abstract_zh || task.abstract || task.metadata?.abstract_zh || task.metadata?.abstract || "";
    const categories = (task.tags || []).join("、") || PR.t("未附加分類"); // i18n-ok: 全形頓號僅作為多重分類分隔符。
    const state = PR.t(statusLabel(task.status || "unread"));
    const readAction = task.saved
      ? btn(PR.t("附加 PDF"), "attach-pdf", "line", 'data-key="' + escAttr(task.saved_key) + '"') + (task.pdf_state === "failed" ? btn(PR.t("重試 PDF"), "retry-pdf", "line", 'data-key="' + escAttr(task.saved_key) + '"') : "")
      : '<a class="btn sm accent" href="/read/' + escAttr(task.id) + '">' + PR.t("繼續閱讀") + '</a>';
    const summaryBody = summary ? '<article class="rw-quick-peek-summary markdown">' + PR.mdBlocks(summary) + '</article><p class="rw-source">' + PR.t("根據來源摘要整理") + '</p>' : '<p class="rw-quick-peek-abstract">' + PR.md(abstract || PR.t("來源未提供摘要。")) + '</p><p class="rw-source">' + PR.t("來源摘要") + '</p>';
    const list = S.boardVisible || allTasks();
    const index = list.findIndex((item) => item.id === task.id);
    const previous = index > 0 ? btn(PR.t("上一篇"), "quick-peek-previous", "line") : "";
    const next = index >= 0 && index < list.length - 1 ? btn(PR.t("下一篇"), "quick-peek-next", "line") : "";
    drawer.innerHTML = '<div class="rw-quick-peek-head"><h2 id="rw-quick-peek-title">' + PR.t("快速檢視") + '</h2><button type="button" class="rw-quick-peek-close" data-action="quick-peek-close" aria-label="' + escAttr(PR.t("關閉快速檢視")) + '" title="' + escAttr(PR.t("關閉快速檢視")) + '">' + PR.icon("x", "sm") + '</button></div><div class="rw-quick-peek-body"><details class="rw-quick-section" open><summary>' + PR.t("概覽") + '</summary><div class="rw-quick-section-body"><span class="rw-chip">' + esc(state) + '</span><h3 class="rw-quick-peek-title">' + titleHtml(title) + '</h3><p class="rw-quick-peek-meta">' + esc([authors, task.year || task.metadata?.year, task.venue].filter(Boolean).join(" · ")) + '</p><dl class="rw-quick-peek-status"><dt>' + PR.t("分類") + '</dt><dd>' + esc(categories) + '</dd><dt>' + PR.t("閱讀狀態") + '</dt><dd>' + esc(state) + '</dd><dt>' + PR.t("閱讀進度") + '</dt><dd>' + (task.saved ? "—" : PR.t("閱讀進度 {n}%", { n: Math.round(Number(task.progress || 0) * 100) })) + '</dd><dt>PDF</dt><dd>' + esc(quickPeekPdfState(task)) + '</dd></dl>' + quickPeekEditor(task) + '</div></details><details class="rw-quick-section" open><summary>' + PR.t("摘要") + '</summary><div class="rw-quick-section-body">' + summaryBody + '</div></details><details class="rw-quick-section" open><summary>' + PR.t("閱讀紀錄") + '</summary><div class="rw-quick-section-body rw-quick-peek-records">' + quickPeekRecordsHtml(task) + '</div></details></div><div class="rw-quick-peek-footer"><div class="rw-quick-peek-nav">' + previous + next + '</div><div class="rw-quick-peek-actions">' + readAction + '</div></div>';
    renderTitleNodes(drawer);
    drawer.classList.add("is-open"); drawer.setAttribute("aria-hidden", "false"); scrim.classList.add("is-open");
    loadQuickPeekRecords(task);
  }
  function openQuickPeek(taskId, trigger) {
    if (!allTasks().some((task) => task.id === taskId)) return;
    if (S.quickPeekTaskId && S.quickPeekTaskId !== taskId) {
      document.querySelector(`.rw-task[data-task="${CSS.escape(S.quickPeekTaskId)}"]`)?.setAttribute("aria-expanded", "false");
    }
    S.quickPeekTaskId = taskId; quickPeekTrigger = trigger || document.querySelector('.rw-task[data-task="' + CSS.escape(taskId) + '"]');
    renderQuickPeek(); requestAnimationFrame(() => $("[data-action='quick-peek-close']")?.focus());
    document.querySelector(`.rw-task[data-task="${CSS.escape(taskId)}"]`)?.setAttribute("aria-expanded", "true");
  }
  function closeQuickPeek(restoreFocus = true) {
    if (!S.quickPeekTaskId) return false;
    const trigger = quickPeekTrigger;
    document.querySelector(`.rw-task[data-task="${CSS.escape(S.quickPeekTaskId)}"]`)?.setAttribute("aria-expanded", "false");
    S.quickPeekTaskId = ""; quickPeekTrigger = null; renderQuickPeek();
    if (restoreFocus && trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
    return true;
  }
  function rememberExploreInputs() {
    const fields = { "rw-query": "query", "rw-venue-query": "venueQuery", "rw-year-from": "yearFrom", "rw-year-to": "yearTo", "rw-sort": "exploreSort" };
    for (const [id, key] of Object.entries(fields)) if ($("#" + id)) S[key] = $("#" + id).value;
    if ($("#rw-oa")) S.onlyOA = $("#rw-oa").checked;
  }
  async function searchSources() {
    if (S.venueBusy) return;
    rememberExploreInputs();
    const query = $("#rw-venue-query")?.value?.trim() || "";
    S.venueQuery = query;
    S.errorAction = "retry-source";
    if (!query) { S.error = "請輸入期刊或會議名稱。"; return renderExplore(); } // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    S.venueBusy = true; renderExplore();
    try {
      const r = await PR.api(API + "/search?kind=sources&q=" + encodeURIComponent(query));
      S.venueOptions = r.results || []; S.venueWarning = r.warning || "";
      const selected = new Map(S.venueSelected.filter((s) => S.venueOptions.some((candidate) => candidate.id === s.id)).map((s) => [s.id, s]));
      S.venueOptions.filter((s) => s.suggested).forEach((s) => selected.set(s.id, s));
      S.venueSelected = Array.from(selected.values());
      if (r.stale) S.venueWarning = [S.venueWarning, r.error, "目前顯示上次成功取得的來源清單。"].filter(Boolean).join(" "); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      S.error = S.venueOptions.length ? "" : "找不到相符的出版來源。"; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      S.errorAction = "retry-search";
    } catch (e) { S.error = e.message; if (S.venueOptions.length) S.venueWarning = "出版來源查詢未完成，保留先前結果。"; } // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    finally { S.venueBusy = false; rememberExploreInputs(); }
    renderExplore();
  }
  async function search() {
    rememberExploreInputs();
    const requestId = S.searchRequestId = (S.searchRequestId || 0) + 1;
    const previous = { results: S.results, authors: S.authors, resultCount: S.resultCount, authorCount: S.authorCount,
      checkedAt: S.checkedAt, lastQuery: S.lastQuery, resultKind: S.resultKind, resultAuthor: S.resultAuthor,
      relationRequest: S.relationRequest, relation: S.relation, stale: S.stale, staleError: S.staleError, warning: S.warning, page: S.page, authorPage: S.authorPage, searchReason: S.searchReason, resultFilters: S.resultFilters, hasMore: S.hasMore, providerHasMore: S.providerHasMore };
    S.error = ""; S.errorAction = ""; S.stale = false; S.warning = ""; S.searchReason = ""; S.relation = false; S.relationRequest = null; S.results = []; S.authors = []; S.page = 1; S.loadingSearch = true;
    const query = String(S.query || "").trim();
    renderExplore();
    try {
        S.resultKind = "works"; S.resultAuthor = "";
        if (!query && S.venueSelected.length && S.exploreSort === "relevance_score:desc") S.exploreSort = "publication_date:desc";
        const realSourceIds = S.venueSelected.map((source) => String(source.id || "").match(/S\d+$/)?.[0]).filter(Boolean);
        const hasManualVenue = S.mode === "conference" && S.venueSelected.some((source) => String(source.id || "").startsWith("venue:"));
        const venueTerms = Array.from(new Set(S.venueSelected.flatMap((source) => source.matched_queries?.length ? source.matched_queries : [source.name]).filter(Boolean)));
        const p = new URLSearchParams({ kind: "works", q: query, page: "1", sort: S.exploreSort, year_from: S.yearFrom, year_to: S.yearTo, open_access: S.onlyOA ? "1" : "0" });
        if (realSourceIds.length) p.set("source_ids", realSourceIds.join("|"));
        S.resultFilters = Object.fromEntries(p); S.lastQuery = query;
        const providers = [];
        if (S.mode !== "conference" || !S.venueSelected.length || realSourceIds.length) providers.push({ name: "OpenAlex", url: API + "/search?" + p });
        if (S.mode === "conference" && S.venueSelected.length) {
          const venueParams = { q: query, venues: venueTerms.join("|"), year_from: S.yearFrom, year_to: S.yearTo, page: "1" };
          providers.push({ name: "DBLP", url: API + "/search?" + new URLSearchParams({ kind: "dblp", ...venueParams }) });
          providers.push({ name: "Crossref", url: API + "/search?" + new URLSearchParams({ kind: "crossref", ...venueParams }) });
        }
        if (!providers.length) throw new Error("請先輸入研究主題，或選擇至少一個出版來源。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
        S.providerStatus = Object.fromEntries(providers.map((provider) => [provider.name, "loading"]));
        S.providerErrors = [];
        S.providerHasMore = {};
        const settled = await Promise.all(providers.map(async (provider) => {
          try {
            const result = await PR.api(provider.url);
            if (requestId !== S.searchRequestId) return { ok: false };
            S.providerStatus[provider.name] = "done";
            S.providerHasMore[provider.name] = Boolean(result.has_more);
            mergeResults(result.results || [], provider.name);
            S.resultCount = S.results.length;
            S.checkedAt = result.checked_at || S.checkedAt;
            if (result.warning) S.providerErrors.push(provider.name + "：" + result.warning); /* i18n-dom: shared DOM translator localizes rendered UI text. */ // i18n-ok: punctuation separator.
            renderExplore();
            return { ok: true, result };
          } catch (error) {
            if (requestId !== S.searchRequestId) return { ok: false };
            S.providerStatus[provider.name] = "failed";
            S.providerHasMore[provider.name] = false;
            S.providerErrors.push(provider.name + "：" + error.message); /* i18n-dom: shared DOM translator localizes rendered UI text. */ // i18n-ok: punctuation separator.
            renderExplore();
            return { ok: false, error };
          }
        }));
        if (requestId !== S.searchRequestId) return;
        if (!settled.some((x) => x.ok)) throw new Error(S.providerErrors.join("；") || "所有論文來源目前都無法連線。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
        S.resultCount = S.results.length;
        S.hasMore = settled.some((x) => x.result?.has_more);
        S.page = 1;
        if (S.providerErrors.length) S.warning = "部分來源未能回應，已先顯示成功取得的結果：" + S.providerErrors.join("；"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
    } catch (e) {
      if (requestId !== S.searchRequestId) return;
      S.error = e.message;
      S.results = previous.results; S.authors = previous.authors; S.resultCount = previous.resultCount; S.authorCount = previous.authorCount;
      S.checkedAt = previous.checkedAt; S.lastQuery = previous.lastQuery; S.resultKind = previous.resultKind; S.resultAuthor = previous.resultAuthor;
      S.relationRequest = previous.relationRequest; S.relation = previous.relation; S.warning = previous.warning; S.page = previous.page; S.authorPage = previous.authorPage; S.searchReason = previous.searchReason;
      S.resultFilters = previous.resultFilters;
      S.hasMore = previous.hasMore;
      S.providerHasMore = previous.providerHasMore;
      if (S.results.length || S.authors.length) {
        S.stale = true;
        S.staleError = "本次搜尋未完成，保留先前結果" + (previous.lastQuery && previous.lastQuery !== query ? "（先前查詢：「" + previous.lastQuery + "」）" : "") + "。"; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      } else { S.stale = previous.stale; S.staleError = previous.staleError; }
    }
    if (requestId === S.searchRequestId) { S.loadingSearch = false; renderExplore(); }
  }
  function mergeResults(incoming, provider) {
    const identity = (work) => {
      const doi = String(work.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
      const arxiv = String(work.arxiv || "").replace(/v\d+$/i, "").toLowerCase();
      const id = workId(work);
      const title = String(work.title || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      return doi ? "doi:" + doi : arxiv ? "arxiv:" + arxiv : id ? "openalex:" + id : "title:" + title;
    };
    const byId = new Map(S.results.map((work, index) => [identity(work), index]));
    for (const raw of incoming) {
      const work = { ...raw, source: raw.source || provider };
      const key = identity(work), index = byId.get(key);
      if (index == null) { byId.set(key, S.results.length); S.results.push({ ...work, sources: [provider] }); }
      else {
        const old = S.results[index];
        S.results[index] = { ...old, ...Object.fromEntries(Object.entries(work).filter(([, value]) => value != null && value !== "")),
          venue: old.venue || work.venue, abstract: old.abstract || work.abstract, pdf_url: old.pdf_url || work.pdf_url,
          sources: Array.from(new Set([...(old.sources || []), provider])) };
      }
    }
  }
  function setResults(r) { S.results = r.results || []; S.resultCount = r.count; S.hasMore = r.has_more ?? ((r.page || 1) * 20 < r.count); S.checkedAt = r.checked_at; S.stale = Boolean(r.stale); S.staleError = r.error || ""; S.warning = r.warning || ""; S.searchReason = r.reason || ""; S.relation = Boolean(r.relation); }
  async function loadRelation(id, relation = "related", title = "", doi = "") {
    if (S.relationBusy) return;
    rememberExploreInputs();
    S.relationBusy = true;
    S.mode = "topic";
    S.tab = "explore";
    switchTab("explore");
    S.error = "";
    S.stale = false;
    S.warning = "";
    S.results = [];
    S.page = 1;
    S.loadingSearch = true;
    const prevKeywords = S.relationRequest?.keywords;
    const prevTopics = S.relationRequest?.topics;
    const prevAiKeywords = S.relationRequest?.aiKeywords;
    S.relation = true;
    S.relationRequest = { id, relation, title, doi, keywords: prevKeywords, topics: prevTopics, aiKeywords: prevAiKeywords };
    renderExplore();
    try {
      const qs = new URLSearchParams({ relation, page: "1" });
      if (title) qs.set("start_title", title);
      if (doi) qs.set("start_doi", doi);
      const r = await PR.api(API + "/work/" + encodeURIComponent(id) + "?" + qs.toString());
      S.page = 1;
      setResults(r);
      if (r.seed_title) S.relationRequest.title = r.seed_title;
      if (r.seed_id) S.relationRequest.id = r.seed_id;
      if (r.seed_doi) S.relationRequest.doi = r.seed_doi;
      if (r.seed_keywords) S.relationRequest.keywords = r.seed_keywords;
      if (r.seed_topics) S.relationRequest.topics = r.seed_topics;
      S.error = "";
    } catch (e) {
      S.error = e.message;
      if (S.results.length) {
        S.stale = true;
        S.staleError = "本次論文關聯查詢未完成，保留先前結果。"; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      }
    } finally {
      S.relationBusy = false;
      S.loadingSearch = false;
      renderExplore();
    }
  }
  async function relations(button) {
    if (S.relationBusy) return;
    const id = button.dataset.work || S.relationRequest?.id;
    const relation = button.dataset.relation || "related";
    const title = button.dataset.title || S.relationRequest?.title || "";
    const doi = button.dataset.doi || S.relationRequest?.doi || "";
    return loadRelation(id, relation, title, doi);
  }
  async function loadMore(button) {
    if (S.pageBusy) return;
    const requestId = S.searchRequestId, page = Number(S.page || 1) + 1;
    S.pageBusy = true; button.disabled = true; button.innerHTML = '<i class="spin"></i> 正在載入…'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    try {
      let providers;
      if (S.relationRequest) {
        const qs = new URLSearchParams({ relation: S.relationRequest.relation, page: String(page) });
        if (S.relationRequest.title) qs.set("start_title", S.relationRequest.title);
        if (S.relationRequest.doi) qs.set("start_doi", S.relationRequest.doi);
        providers = [{ name: "OpenAlex", url: API + "/work/" + encodeURIComponent(S.relationRequest.id) + "?" + qs.toString() }];
      } else {
        const oa = new URLSearchParams(S.resultFilters || { kind: "works", q: S.lastQuery || "", sort: S.exploreSort }); oa.set("page", String(page));
        providers = [];
        if (S.mode !== "conference" || !S.venueSelected.length || S.venueSelected.some((source) => /S\d+$/.test(source.id || ""))) providers.push({ name: "OpenAlex", url: API + "/search?" + oa });
        if (S.mode === "conference" && S.venueSelected.length) {
          const venueParams = { q: S.lastQuery || "", venues: S.venueSelected.flatMap((x) => x.matched_queries?.length ? x.matched_queries : [x.name]).join("|"), year_from: S.yearFrom, year_to: S.yearTo, page: String(page) };
          providers.push({ name: "DBLP", url: API + "/search?" + new URLSearchParams({ kind: "dblp", ...venueParams }) });
          providers.push({ name: "Crossref", url: API + "/search?" + new URLSearchParams({ kind: "crossref", ...venueParams }) });
        }
      }
      if (S.providerHasMore) {
        providers = providers.filter((p) => S.providerHasMore[p.name] !== false);
      }
      if (!providers.length) {
        S.hasMore = false;
        renderExplore();
        return;
      }
      const settled = await Promise.allSettled(providers.map((source) => PR.api(source.url)));
      if (requestId !== S.searchRequestId) return;
      let success = 0; const errors = [];
      if (!S.providerHasMore) S.providerHasMore = {};
      settled.forEach((result, index) => {
        const source = providers[index];
        if (result.status === "fulfilled") {
          success++;
          mergeResults(result.value.results || [], source.name);
          S.providerHasMore[source.name] = Boolean(result.value.has_more);
        } else {
          S.providerHasMore[source.name] = false;
          errors.push(PR.t("{source}：{message}", { source: source.name, message: PR.t(result.reason.message) }));
        }
      });
      if (!success) throw new Error(errors.join("；") || "目前無法載入更多論文。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
      S.page = page;
      S.hasMore = Object.values(S.providerHasMore).some(Boolean);
      S.warning = errors.length ? PR.t("部分來源的下一頁未能載入，已保留成功取得的結果：{errors}", { errors: errors.join("; ") }) : "";
      S.resultCount = S.results.length; renderExplore();
    } catch (error) { PR.toast(PR.t(error.message)); }
    finally { S.pageBusy = false; if (button.isConnected) { button.disabled = false; button.textContent = "載入更多論文"; } } /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  function openModal(title, bodyHtml, onSave, saveLabel = "儲存", options = {}) { // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    const modal = $("#rw-modal");
    modal.innerHTML = '<div class="rw-dialog' + (options.headerClose ? ' has-header-close' : '') + '" role="dialog" aria-modal="true"><div class="rw-dialog-head"><h2>' + titleHtml(title) + '</h2>' + (options.headerClose ? '<button type="button" class="rw-dialog-close" data-modal-close aria-label="關閉" title="關閉">×</button>' : '') + '</div><div class="rw-dialog-body">' + bodyHtml + '</div><div class="rw-dialog-foot">' + (saveLabel === "關閉" ? '<button class="btn line" data-modal-close>關閉</button>' : '<button class="btn line" data-modal-close>關閉</button><button class="btn accent" data-modal-save>' + esc(saveLabel) + '</button>') + '</div></div>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    modal.hidden = false;
    $$("[data-modal-close]", modal).forEach((close) => { close.onclick = () => { modal.hidden = true; }; });
    const save = $("[data-modal-save]", modal);
    if (save) save.onclick = async () => { try { await onSave(modal); modal.hidden = true; } catch (e) { PR.toast(esc(e.message)); } };
    modal.onclick = (e) => { if (options.dismissOnBackdrop !== false && e.target === modal) modal.hidden = true; };
    return modal;
  }
  function queueModal(work) {
    const cats = S.categories.map((c) => '<label class="rw-category-option"><input type="checkbox" name="q-category" value="' + escAttr(c) + '"><span>' + esc(c) + '</span></label>').join("");
    if (!work) return PR.toast("找不到論文資料，請重新搜尋。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
    const categoryPicker = cats ? '<div id="q-categories" class="rw-category-picker" role="group" aria-label="分類（可複選）">' + cats + '</div>' : '<p class="rw-source rw-category-empty">目前尚未建立分類，可直接加入閱讀看板。</p>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    const body = '<div class="rw-form-grid"><div class="rw-field wide"><label>分類（可複選）</label>' + categoryPicker + '<small>加入閱讀看板會開始尋找公開 PDF；這與候選清單分開管理。</small></div><div class="rw-field wide"><label class="rw-check"><input id="q-interested" type="checkbox">標記為感興趣</label></div></div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    openModal("加入閱讀看板", body, async (modal) => { /* i18n-dom: shared DOM translator localizes rendered UI text. */
      const category = Array.from($$("input[name=\"q-category\"]:checked", modal)).map((input) => input.value);
      await PR.api(API + "/save-paper", { method: "POST", body: { paper: work, categories: category, interested: $("#q-interested", modal).checked } });
      PR.toast("已加入待閱讀看板並開始尋找可用 PDF；不會自動整理摘要。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
      const data = await PR.api(API); S.saved = data.saved || S.saved; S.items = data.items || S.items; renderExplore();
    }, "加入並尋找 PDF"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  async function patchTask(task, fields) {
    await saveTaskFields(task, fields);
    const data = await PR.api(API); S.items = normalizeItems(data.items || S.items); S.saved = data.saved || S.saved; renderActive();
  }
  function saveTaskFields(task, fields) {
    return PR.api(API + "/item", { method: "POST", body: task.saved ? { saved_key: task.saved_key || task.id.slice(6), ...fields } : { id: task.id, ...fields } });
  }
  function attachPdf(key) {
    const input = document.createElement("input"); input.type = "file"; input.accept = "application/pdf,.pdf"; input.hidden = true;
    document.body.appendChild(input);
    input.onchange = async () => {
      const file = input.files && input.files[0]; input.remove(); if (!file) return;
      try {
        PR.toast("正在加入 PDF 並連結閱讀計畫…", null, 30000); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
        const qs = new URLSearchParams({ paper_key: key, name: file.name });
        const result = await PR.api(API + "/attach-pdf?" + qs, { method: "POST", body: file });
        const data = await PR.api(API); S.items = data.items || []; S.saved = data.saved || []; PR.toast(result.queued ? "PDF 已加入文獻庫，正在準備原頁與文字。" : "PDF 已加入文獻庫，閱讀計畫已保留。", null, 6000); renderActive(); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      } catch (e) { PR.toast(PR.t("附加 PDF 失敗：{message}", { message: PR.t(e.message) })); }
    };
    input.click();
  }
  function statusManager() {
    let values = S.statuses.map((x) => ({ ...x }));
    const draw = () => '<p class="rw-source">拖曳左側把手調整順序。內建狀態可改名稱與顏色；刪除自訂狀態時，該欄論文會移至指定狀態。</p><div class="rw-list">' + values.map((s) => '<div class="rw-follow rw-status-row" data-status-row="' + escAttr(s.id) + '"><span class="rw-status-grip" draggable="true" data-status-drag="' + escAttr(s.id) + '" title="拖曳調整順序" aria-label="拖曳調整狀態順序">⠿</span><span class="rw-chip" style="border-color:' + escAttr(s.color) + '">●</span><input data-status-label="' + escAttr(s.id) + '" value="' + escAttr(s.label) + '" maxlength="32"><input type="color" data-status-color="' + escAttr(s.id) + '" value="' + (/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#8b8b8b") + '">' + (!s.builtin ? '<select data-status-move="' + escAttr(s.id) + '">' + values.filter((x) => x.id !== s.id).map((x) => '<option value="' + escAttr(x.id) + '">刪除後移至 ' + esc(x.label) + '</option>').join("") + '</select><button class="btn sm" data-status-remove="' + escAttr(s.id) + '">刪除</button>' : '<span class="rw-source">內建</span>') + '</div>').join("") + '</div><button class="btn sm line" data-status-add>＋ 新增自訂狀態</button>'; // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    const moves = {};
    let draggedId = null;
    const modal = $("#rw-modal");
    const captureDraft = () => {
      values = values.map((s) => ({
        ...s,
        label: $('[data-status-label="' + CSS.escape(s.id) + '"]', modal)?.value ?? s.label,
        color: $('[data-status-color="' + CSS.escape(s.id) + '"]', modal)?.value ?? s.color,
      }));
    };
    openModal("管理閱讀狀態", draw(), async (dialog) => { // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      captureDraft();
      values = values.map((s, position) => ({ ...s, label: s.label.trim(), position }));
      const r = await PR.api(API + "/statuses", { method: "POST", body: { statuses: values, moves } }); S.statuses = r.statuses; paint();
    });
    modal.onclick = (e) => {
      if (e.target === modal) { modal.hidden = true; return; }
      const remove = e.target.closest("[data-status-remove]"), add = e.target.closest("[data-status-add]");
      if (add) { captureDraft(); values.push({ id: "custom-" + Math.random().toString(36).slice(2, 10), label: "新狀態", color: "#8b8b8b", builtin: false }); $(".rw-dialog-body", modal).innerHTML = draw(); return; } // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
      if (remove) {
        const id = remove.dataset.statusRemove, move = $('[data-status-move="' + CSS.escape(id) + '"]', modal)?.value;
        captureDraft(); moves[id] = move; values = values.filter((x) => x.id !== id); $(".rw-dialog-body", modal).innerHTML = draw();
      }
    };
    modal.ondragstart = (e) => {
      const handle = e.target.closest("[data-status-drag]");
      if (!handle) return;
      draggedId = handle.dataset.statusDrag;
      e.dataTransfer.setData("text/plain", draggedId);
      e.dataTransfer.effectAllowed = "move";
      handle.closest("[data-status-row]")?.classList.add("dragging");
    };
    modal.ondragend = () => { draggedId = null; $$(".rw-status-row", modal).forEach((row) => row.classList.remove("dragging", "drop-target")); };
    modal.ondragover = (e) => {
      const row = e.target.closest("[data-status-row]");
      if (!row || !draggedId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      $$(".rw-status-row.drop-target", modal).forEach((item) => item !== row && item.classList.remove("drop-target"));
      row.classList.add("drop-target");
    };
    modal.ondragleave = (e) => {
      const row = e.target.closest("[data-status-row]");
      if (row && !row.contains(e.relatedTarget)) row.classList.remove("drop-target");
    };
    modal.ondrop = (e) => {
      const target = e.target.closest("[data-status-row]");
      const sourceId = draggedId || e.dataTransfer.getData("text/plain");
      if (!target || !sourceId || target.dataset.statusRow === sourceId) return;
      e.preventDefault();
      captureDraft();
      const sourceIndex = values.findIndex((s) => s.id === sourceId);
      if (sourceIndex < 0 || !values.some((s) => s.id === target.dataset.statusRow)) return;
      const before = e.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2;
      const [source] = values.splice(sourceIndex, 1);
      let insertAt = values.findIndex((s) => s.id === target.dataset.statusRow);
      if (!before) insertAt += 1;
      values.splice(insertAt, 0, source);
      $(".rw-dialog-body", modal).innerHTML = draw();
      draggedId = null;
    };
  }
  async function aiSummary() {
    const record = S.candidates.find((c) => c.paper_key === S.summaryKey);
    const chosen = record ? [record.paper] : [];
    if (!chosen.length) return PR.toast("請先從候選清單選擇一篇論文。"); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    const button = $("[data-action='candidate-summary'][data-key='" + CSS.escape(S.summaryKey) + "']");
    if (S.summaryBusy) return;
    if (record.summary_markdown && !S.forceSummary) return showSummary(record);
    S.forceSummary = false;
    S.summaryBusy = true;
    if (button) { button.disabled = true; button.textContent = "正在整理摘要…"; } /* i18n-dom: shared DOM translator localizes rendered UI text. */
    try {
      const r = await PR.api(API + "/ai-summary", { method: "POST", body: { papers: chosen } });
      S.summaryText = r.text || "";
      await PR.api(API + "/candidate", { method: "POST", body: { action: "save-summary", paper: chosen[0], summary_markdown: S.summaryText, model: r.model || "" } });
      const current = await PR.api(API); S.candidates = current.candidates || S.candidates; S.summaries = current.summaries || S.summaries;
      return showSummary(S.candidates.find((c) => c.paper_key === S.summaryKey) || { ...record, summary_markdown: S.summaryText, summary_model: r.model });
    } catch (e) { PR.toast(PR.t("摘要整理未完成：{message}", { message: PR.t(e.message) })); }
    finally { S.summaryBusy = false; if (button) { button.disabled = false; button.textContent = "整理摘要"; } } /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  function showSummary(record) {
    const content = '<div class="rw-source">' + PR.t("根據候選論文的來源摘要整理") + (record.summary_model ? ' · ' + esc(record.summary_model) : '') + (record.updated || record.summary_updated ? ' · ' + esc(record.updated || record.summary_updated) : '') + '</div><article class="markdown rw-summary">' + PR.mdBlocks(record.summary_markdown || "") + '</article><div class="rw-dialog-foot"><button class="btn line" data-download-summary>下載</button><button class="btn line" data-export-summary-vault>匯入 Obsidian</button></div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    S.summaryText = record.summary_markdown || "";
    openModal(PR.t("論文摘要整理"), content, async () => {}, "關閉"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
    const download = $("[data-download-summary]", $("#rw-modal"));
    if (download) download.onclick = () => exportMarkdown(paperExportStem(record) + "-summary.md", S.summaryText);
    const vault = $("[data-export-summary-vault]", $("#rw-modal"));
    if (vault) vault.onclick = async () => { vault.disabled = true; try { await exportSummaryToVault(record); } finally { vault.disabled = false; } };
  }
  async function exportMarkdown(filename, text) {
    const safeName = filename.replace(/[\\/:*?"<>|]/g, "_");
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: safeName, types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }] });
        const stream = await handle.createWritable(); await stream.write(text); await stream.close();
        PR.toast(PR.t("Markdown 已匯出。")); return; /* i18n-dom: shared DOM translator localizes rendered UI text. */
      } catch (error) { if (error.name === "AbortError") return; throw error; }
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = safeName; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function shortExportStem(value, fallback) {
    let name = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim();
    if (name.length > 80) name = (name.slice(0, 80).replace(/\s+\S*$/, "").trim() || name.slice(0, 80)).trim();
    return name.replace(/[ .-]+$/, "") || fallback;
  }

  function paperExportStem(record) {
    const paper = record?.paper || {};
    return shortExportStem(paper.title_en || paper.title || paper.title_zh, "PaperRead");
  }
  function showComparisonRecord(proposal) {
    S.compareProposal = proposal || null;
    if (!proposal) return PR.toast(PR.t("找不到比較結果。"));
    const status = proposal.status === "accepted" ? PR.t("已存入 Obsidian") : proposal.status === "rejected" ? PR.t("已捨棄") : PR.t("待審閱");
    const sources = (proposal.sources || proposal.evidence || []).map((source) => {
      const label = source.title || source.paper_title || source.id || PR.t("論文");
      return '<li>' + titleHtml(label) + (source.location ? ' <small>' + esc(source.location) + '</small>' : '') + '</li>';
    }).join("");
    const sourceCount = (proposal.sources || proposal.evidence || []).length;
    const linkedCount = Number.isFinite(Number(proposal.linked_paper_count)) ? Number(proposal.linked_paper_count) : sourceCount;
    const linkReminder = sourceCount > linkedCount
      ? '<p class="rw-source rw-export-reminder">' + PR.t("提醒：有部分選定論文尚未匯出單篇筆記。仍可產生比較報告，但這些論文於 Obsidian 中可能暫時無法建立雙向連結。建議先匯出單篇筆記，再重新產生比較報告。") + '</p>'
      : "";
    const actions = '<div class="rw-dialog-actions">' +
      btn(PR.t("編輯名稱"), "edit-comparison-title", "line", 'data-id="' + escAttr(proposal.id) + '"') +
      btn(PR.t("下載"), "export-comparison", "line") +
      (proposal.status === "pending" ? btn(PR.t("接受並存入 Obsidian"), "compare-accept", "accent") + btn(PR.t("捨棄草稿"), "compare-reject", "line") : '') +
      '</div>';
    const body = '<div class="rw-source">' + PR.t("狀態：{status}；請先核對各篇論文的原文證據與評估條件。", { status }) + '</div>' +
      '<article class="markdown rw-summary">' + PR.mdBlocks(proposal.content || "") + '</article>' +
      (sources ? '<section class="rw-evidence"><h3>' + PR.t("證據來源") + '</h3><ul>' + sources + '</ul>' + linkReminder + '</section>' : linkReminder) + actions;
    openModal(proposal.title || PR.t("論文比較"), body, async () => {}, "關閉", { headerClose: true }); // i18n-ok: openModal uses this control sentinel.
  }
  async function exportComparison(proposal) {
    if (!proposal?.content) return;
    const title = proposal.title || PR.t("論文比較");
    const body = String(proposal.content).replace(/^\s*#\s+.*(?:\r?\n|$)/, "").trimStart();
    await exportMarkdown(shortExportStem(title, "paper-comparison") + ".md", "# " + title + "\n\n" + body);
  }

  async function chooseVault() {
    if (window.easyreadDesktop && typeof window.easyreadDesktop.pickFolder === "function") {
      return window.easyreadDesktop.pickFolder();
    }
    const result = await PR.api("/api/library/pick-folder", { method: "POST", body: {} });
    return result.path || "";
  }

  async function ensureVault() {
    const status = await PR.api(RESEARCH_API + "/status");
    if (status.configured) return true;
    const path = await chooseVault();
    if (!path) return false;
    await PR.api(RESEARCH_API + "/setup", { method: "POST", body: { vault: path } });
    PR.toast(PR.t("已連結 Obsidian Vault。"));
    return true;
  }

  async function exportSummaryToVault(record) {
    if (!record?.paper_key || !record.summary_markdown) return;
    if (!(await ensureVault())) return;
    const result = await PR.api(API + "/export/summary", { method: "POST", body: { paper_key: record.paper_key } });
    if (result.conflicts?.length) throw new Error(PR.t("有檔案未能安全更新，請先檢查衝突。"));
    PR.toast(PR.t("摘要已匯入 Obsidian Vault。"));
  }

  async function aiQuery() {
    const query = $("#rw-query")?.value?.trim() || "";
    if (!query) return PR.toast(PR.t("請先輸入研究主題。")); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    const button = $("[data-action='ai-query']"); if (button?.disabled) return;
    if (button) { button.disabled = true; button.innerHTML = '<i class="spin"></i> 正在產生搜尋關鍵字…'; } /* i18n-dom: shared DOM translator localizes rendered UI text. */
    try {
      const r = await PR.api(API + "/ai-query", { method: "POST", body: { query } });
      const suggestions = (r.suggestions || []).map((x) => String(x || "").trim()).filter(Boolean);
      const chips = suggestions.length
        ? '<div class="rw-ai-chips"><span class="rw-source">' + PR.t("點擊直接以此關鍵字搜尋：") + '</span><div class="rw-keyword-pills">' +
          suggestions.map((kw) => '<button type="button" class="btn sm line" data-action="apply-single-kw" data-kw="' + escAttr(kw) + '">' + esc(kw) + '</button>').join("") +
          '</div></div>'
        : '';
      const bodyHtml = chips +
        '<p class="rw-source">' + PR.t("可編輯關鍵字草稿；點選「套用關鍵字」將以第一行關鍵字進行搜尋，或直接點選上方按鈕。選取草稿中的文字可再按「AI 改寫」。") + '</p>' +
        '<div class="rw-field"><label>' + PR.t("關鍵字草稿（每行一組）") + '</label><textarea id="rw-ai-query" rows="6">' + esc(suggestions.join("\n")) + '</textarea></div>' +
        '<button type="button" class="btn line" data-action="rewrite-selected">' + PR.t("AI 改寫選取文字") + '</button><div id="rw-rewrite-results"></div>';
      openModal(PR.t("AI 建議的英文關鍵字"), bodyHtml, async (modal) => {
        const edited = $("#rw-ai-query", modal).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        if (!edited.length) throw new Error(PR.t("請保留至少一組關鍵字。"));
        const chosen = edited[0];
        S.mode = "topic"; S.query = chosen; S.results = []; renderExplore(); await search();
      }, PR.t("套用關鍵字"), { dismissOnBackdrop: false, headerClose: true });
    } catch (e) { PR.toast(PR.t("AI 關鍵字產生失敗：{message}", { message: PR.t(e.message) })); }
    finally { if (button?.isConnected) { button.disabled = false; button.textContent = "AI 產生搜尋關鍵字"; } } /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  async function rewriteSelected() {
    const modal = $("#rw-modal"), draft = $("#rw-ai-query", modal);
    const start = draft?.selectionStart ?? 0, end = draft?.selectionEnd ?? 0;
    const selected = draft?.value.slice(start, end).trim() || "";
    if (!selected) return PR.toast("請先在關鍵字草稿中選取要改寫的文字。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
    const button = $("[data-action='rewrite-selected']", modal); if (button.disabled) return;
    button.disabled = true; button.textContent = "AI 正在改寫…"; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    $("#rw-rewrite-results", modal).innerHTML = '<div class="rw-source" role="status">正在依選取文字產生建議…</div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    try {
      const result = await PR.api(API + "/ai-rewrite", { method: "POST", body: { selected_text: selected, context: draft.value } });
      S.rewriteRange = { start, end };
      $("#rw-rewrite-results", modal).innerHTML = '<div class="rw-list">' + result.suggestions.map((value, index) => '<div class="rw-rewrite-option"><span>' + esc(value) + '</span><button class="btn sm line" data-rewrite-accept="' + index + '">套用</button></div>').join("") + '</div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
      S.rewriteSuggestions = result.suggestions;
    } catch (e) { $("#rw-rewrite-results", modal).innerHTML = '<div class="rw-error">' + esc(PR.t("{message} 請確認模型設定後重試。", { message: PR.t(e.message) })) + '</div>'; }
    finally { button.disabled = false; button.textContent = "AI 改寫選取文字"; } /* i18n-dom: shared DOM translator localizes rendered UI text. */
  }
  async function generatePath() {
    if (S.pathLoading) return;
    const topicField = $("#rw-path-topic"), goalField = $("#rw-path-goal");
    S.pathTopic = topicField?.value.trim() || ""; S.pathGoal = goalField?.value.trim() || "";
    const params = new URLSearchParams(location.search), retryRequest = S.pathRetryRequest;
    const startPaper = retryRequest?.start_paper || { title: params.get("start_title") || params.get("title") || "", doi: params.get("start_doi") || "", openalex_id: params.get("start_openalex") || "" };
    if (!S.pathTopic && !startPaper.title) { S.pathError = "請輸入研究主題，或從閱讀器以目前論文作為起點。"; renderPath(); return; } /* i18n-dom: shared DOM translator localizes rendered UI text. */
    S.pathLoading = true; S.pathError = ""; renderPath();
    try {
      const candidatePapers = (retryRequest?.candidate_papers || retryRequest?.papers || S.candidates.map((c) => c.paper).filter(Boolean)).slice(0, 30);
      const searchResults = (retryRequest?.search_results || S.results || []).slice(0, 30);
      const body = {
        topic: S.pathTopic, goal: S.pathGoal, start_paper: startPaper,
        candidate_papers: candidatePapers, search_results: searchResults,
      };
      if (retryRequest?.model) body.model = retryRequest.model;
      const result = await PR.api(API + "/reading-path/tasks", { method: "POST", body });
      S.pathRetryRequest = null;
      PR.researchTaskMonitor?.track(result.task, true);
    } catch (e) { S.pathError = e.message; }
    finally { S.pathLoading = false; renderPath(); }
  }
  async function updatePathRelations() {
    if (S.pathRelationsLoading || !S.pathId) return;
    S.pathRelationsLoading = true; S.pathRelationError = ""; renderPath();
    try {
      const result = await PR.api(API + "/reading-path/relations", { method: "POST", body: { path_id: S.pathId, revision: S.pathRevision, force: true } });
      if (result.path) applyPathSnapshot(result.path);
      if (result.partial) S.pathRelationError = result.path?.relations_error || PR.t("部分引用資料暫時無法取得。");
    } catch (error) { S.pathRelationError = error.message || String(error); }
    finally { S.pathRelationsLoading = false; renderPath(); }
  }
  async function movePathPaper(key, direction) {
    const from = S.pathResults.findIndex((step) => step.paper_key === key), to = from + Number(direction || 0);
    if (from < 0 || to < 0 || to >= S.pathResults.length || !S.pathId) return;
    const order = S.pathResults.map((step) => step.paper_key);
    [order[from], order[to]] = [order[to], order[from]];
    try {
      const result = await PR.api(API + "/reading-path/reorder", { method: "POST", body: { path_id: S.pathId, revision: S.pathRevision, paper_keys: order } });
      if (result.path) { applyPathSnapshot(result.path); PR.toast(PR.t("閱讀順序已更新。")); }
      renderPath();
    } catch (error) { PR.toast(PR.t(error.message)); }
  }
  let lastComparisonRefresh = "";
  if (typeof PR.on === "function") PR.on("research-task-update", (status) => {
    const task = status?.comparison;
    if (!task) return;
    const wasActive = S.compareTask && ["queued", "running", "cancelling"].includes(S.compareTask.state);
    S.compareTask = task;
    if (S.tab === "comparisons") renderComparisons();
    if (task.state === "completed" && wasActive && lastComparisonRefresh !== task.id) {
      lastComparisonRefresh = task.id;
      refreshComparisons();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (closeQuickPeek()) return;
    $$(".rw-candidate-more[open]").forEach((menu) => { menu.open = false; $("summary", menu).focus(); });
  });
  document.addEventListener("click", async (e) => {
    $$(".rw-candidate-more[open]").forEach((menu) => {
      if (!menu.contains(e.target) || e.target.closest("[data-action]")) {
        menu.open = false;
        if (menu.contains(e.target)) $("summary", menu).focus();
      }
    });
    if (e.target.id === "rw-quick-peek-scrim") { closeQuickPeek(); return; }
    const tab = e.target.closest("[data-tab]"); if (tab) return switchTab(tab.dataset.tab);
    const mode = e.target.closest(".rw-mode [data-mode]"); if (mode) { rememberExploreInputs(); S.mode = mode.dataset.mode; S.error = ""; S.stale = false; S.warning = ""; S.results = []; S.authors = []; return renderExplore(); }
    const rewrite = e.target.closest("[data-rewrite-accept]"); if (rewrite) {
      const value = S.rewriteSuggestions?.[Number(rewrite.dataset.rewriteAccept)];
      if (typeof value === "string" && value.trim()) {
        S.mode = "topic"; S.query = value; S.results = []; S.error = ""; S.stale = false;
        $("#rw-modal").hidden = true; renderExplore(); await search();
      }
      return;
    }
    const card = e.target.closest(".rw-task[data-task]");
    if (card && S.tab === "board" && Date.now() >= suppressQuickPeekUntil && !e.target.closest("a,button,input,select,textarea,label,summary")) {
      openQuickPeek(card.dataset.task, card); return;
    }
    const b = e.target.closest("[data-action]"); if (!b) return;
    try {
      switch (b.dataset.action) {
        case "keyword-mode": S.keywordMode = b.dataset.kwMode || (b.dataset.mode === "any" ? "any" : "all"); await loadKeywordMatches(); return renderKeywords();
        case "keyword-archive": await PR.api(API + "/keywords/archive", { method: "POST", body: { keyword_id: b.dataset.keywordId, archived: true } }); S.keywordSelected.delete(b.dataset.keywordId); return loadKeywords(false);
        case "keyword-restore": await PR.api(API + "/keywords/archive", { method: "POST", body: { keyword_id: b.dataset.keywordId, archived: false } }); return loadKeywords(false);
        case "keyword-delete": {
          if (!window.confirm(PR.t("確定要永久移除此關鍵字嗎？相關的比對關聯也會一併清除。"))) return;
          await PR.api(API + "/keywords/delete", { method: "POST", body: { keyword_id: b.dataset.keywordId } });
          S.keywordSelected.delete(b.dataset.keywordId); return loadKeywords(false);
        }
        case "keyword-batch-archive": {
          if (!S.keywordSelected.size) return;
          await PR.api(API + "/keywords/archive", { method: "POST", body: { keyword_ids: [...S.keywordSelected], archived: true } });
          S.keywordSelected.clear(); return loadKeywords(false);
        }
        case "keyword-batch-restore": {
          if (!S.keywordSelected.size) return;
          await PR.api(API + "/keywords/archive", { method: "POST", body: { keyword_ids: [...S.keywordSelected], archived: false } });
          S.keywordSelected.clear(); return loadKeywords(false);
        }
        case "keyword-batch-delete": {
          if (!S.keywordSelected.size) return;
          if (!window.confirm(PR.t("確定要永久移除選取的 {n} 個關鍵字嗎？相關比對關聯也會一併清除。", { n: S.keywordSelected.size }))) return;
          await PR.api(API + "/keywords/delete", { method: "POST", body: { keyword_ids: [...S.keywordSelected] } });
          S.keywordSelected.clear(); return loadKeywords(false);
        }
        case "keyword-select-all": {
          $$(".rw-keyword-item:not([hidden]) [data-keyword-id]").forEach((cb) => S.keywordSelected.add(cb.dataset.keywordId));
          if (!S.keywordArchived) await loadKeywordMatches();
          return renderKeywords();
        }
        case "keyword-select-none": {
          S.keywordSelected.clear();
          if (!S.keywordArchived) await loadKeywordMatches();
          return renderKeywords();
        }
        case "keyword-edit": {
          const current = S.keywords.find((k) => k.id === b.dataset.keywordId); if (!current) return;
          const name = window.prompt(PR.t("關鍵字名稱"), current.name); if (!name || !name.trim()) return;
          const match = window.prompt(PR.t("原文比對詞"), current.match_text); if (!match || !match.trim()) return;
          const res = await PR.api(API + "/keywords/update", { method: "POST", body: { keyword_id: current.id, name: name.trim(), match_text: match.trim() } });
          await loadKeywords(false); if (res.scan_needed) startKeywordScan(current.id); return;
        }
        case "keyword-create": {
          const nameIn = $("#rw-kw-add-name");
          const matchIn = $("#rw-kw-add-match");
          const name = nameIn?.value.trim(), match = matchIn?.value.trim();
          if (!name || !match) return PR.toast(PR.t("請填寫關鍵字名稱與原文比對詞"));
          const res = await PR.api(API + "/keywords", { method: "POST", body: { name, match_text: match } });
          nameIn.value = ""; matchIn.value = "";
          S.keywordSelected.add(res.keyword.id);
          await loadKeywords(false);
          if (res.scan_needed) startKeywordScan(res.keyword.id);
          return;
        }
        case "keyword-scan": return startKeywordScan();
        case "keyword-scan-cancel": { const id = S.keywordScan?.task?.id; if (id) { const r = await PR.api(API + "/keywords/scan/tasks/" + encodeURIComponent(id) + "/cancel", { method: "POST", body: {} }); S.keywordScan.task = r.task; updateKeywordScanStatus(); } return; }
        case "quick-peek-close": closeQuickPeek(); return;
        case "quick-peek-previous": return quickPeekAdjacent(-1);
        case "quick-peek-next": return quickPeekAdjacent(1);
        case "quick-peek-status": {
          const task = allTasks().find((x) => x.id === S.quickPeekTaskId);
          if (!task || !S.statuses.some((item) => item.id === b.dataset.status)) return;
          await patchTask(task, { status: b.dataset.status });
          PR.toast(PR.t("閱讀狀態已更新。"));
          return;
        }
        case "quick-peek-category": {
          const task = allTasks().find((x) => x.id === S.quickPeekTaskId);
          if (!task || !S.categories.includes(b.dataset.category)) return;
          const tags = new Set(task.tags || []);
          tags.has(b.dataset.category) ? tags.delete(b.dataset.category) : tags.add(b.dataset.category);
          await patchTask(task, { tags: Array.from(tags) });
          PR.toast(PR.t("分類已更新。"));
          return;
        }
        case "quick-peek-star": {
          const task = allTasks().find((x) => x.id === S.quickPeekTaskId);
          if (!task) return;
          const interested = !task.interested;
          await patchTask(task, { interested, starred: interested });
          PR.toast(PR.t("星標已更新。"));
          return;
        }
        case "compare-accept": case "compare-reject": {
          const proposal = S.compareProposal; if (!proposal?.id) return;
          if (b.dataset.action === "compare-accept" && !(await ensureVault())) return;
          S.compareProposal = await PR.api(RESEARCH_API + "/proposals/" + proposal.id + "/review", { method: "POST", body: { decision: b.dataset.action === "compare-accept" ? "accept" : "reject" } });
          if (S.tab === "comparisons") { showComparisonRecord(S.compareProposal); await refreshComparisons(); }
          else renderCandidates();
          if (S.compareProposal.status === "accepted") PR.toast(PR.t("比較草稿已存入 Obsidian。"));
          return;
        }
        case "export-comparison": {
          const proposal = S.compareProposal; await exportComparison(proposal);
          return;
        }
        case "comparisons-refresh": return refreshComparisons();
        case "view-comparison": {
          const proposal = await PR.api(RESEARCH_API + "/proposals/" + encodeURIComponent(b.dataset.id));
          return showComparisonRecord(proposal);
        }
        case "export-comparison-record": {
          const proposal = await PR.api(RESEARCH_API + "/proposals/" + encodeURIComponent(b.dataset.id));
          await exportComparison(proposal);
          return;
        }
        case "export-summary-vault": {
          const record = S.summaries.find((x) => x.paper_key === b.dataset.key) || S.candidates.find((x) => x.paper_key === b.dataset.key);
          await exportSummaryToVault(record);
          return;
        }
        case "edit-comparison-title": {
          const proposal = await PR.api(RESEARCH_API + "/proposals/" + encodeURIComponent(b.dataset.id));
          const current = proposal?.title || PR.t("跨論文比較");
          return openModal(PR.t("編輯比較名稱"), '<label class="rw-field"><span>' + PR.t("比較名稱") + '</span><input id="rw-comparison-title" maxlength="80" value="' + escAttr(current) + '"></label>', async (modal) => {
            const next = $("#rw-comparison-title", modal)?.value.trim();
            if (!next || next === current) return;
            const updated = await PR.api(RESEARCH_API + "/proposals/" + encodeURIComponent(b.dataset.id) + "/title", { method: "POST", body: { title: next } });
            if (S.compareProposal?.id === updated.id) S.compareProposal = updated;
            S.comparisons = S.comparisons.map((item) => item.id === updated.id ? { ...item, title: updated.title } : item);
            renderComparisons();
          }, PR.t("儲存"));
        }
        case "compare-open-picker": S.comparePickerOpen = true; S.compareSetupOpen = false; S.comparePickerCategory = ""; S.comparePickerExpanded = false; return renderComparisons();
        case "compare-picker-category": S.comparePickerCategory = b.dataset.category || ""; S.comparePickerExpanded = false; return renderComparisons();
        case "compare-picker-back": S.comparePickerCategory = ""; S.comparePickerExpanded = false; return renderComparisons();
        case "compare-picker-more": S.comparePickerExpanded = true; return renderComparisons();
        case "compare-open-setup":
          if (S.compareSelection.size < 2 || S.compareSelection.size > 5) return PR.toast(PR.t("請先選擇 2 至 5 篇論文。"));
          S.comparePickerOpen = false; S.compareSetupOpen = true; return renderComparisons();
        case "compare-cancel": S.compareSetupOpen = false; S.comparePickerOpen = true; S.comparePickerCategory = ""; S.comparePickerExpanded = false; history.replaceState({}, "", "/research?mode=comparisons"); return renderComparisons();
        case "compare-add-dimension": {
          const value = S.compareCustomDimension.trim().slice(0, 60);
          if (value) S.compareDimensions.add(value);
          S.compareCustomDimension = ""; return renderComparisons();
        }
        case "compare-start": return startComparison(b);
        case "manage-status": return statusManager();
        case "add-column": return statusManager();
        case "toggle-column":
          if (S.boardExpanded.has(b.dataset.column)) S.boardExpanded.delete(b.dataset.column);
          else S.boardExpanded.add(b.dataset.column);
          return renderBoard();
        case "go-explore": return switchTab("explore");
        case "clear-filters": S.filters = { category: "", status: "", interested: false, pdf: "" }; return renderBoard();
        case "toggle-interested-filter": S.filters.interested = !S.filters.interested; return renderBoard();
        case "retry-search": return search();
        case "retry-source": return searchSources();
        case "search-sources": return searchSources();
        case "clear-source": rememberExploreInputs(); S.venueSelected = []; return renderExplore();
        case "queue": { const key = b.dataset.key; const work = S.results.find((w) => paperKey(w) === key) || S.candidates.find((c) => c.paper_key === key)?.paper || S.pathResults.find((step) => step.paper_key === key)?.paper; return queueModal(work); }
        case "candidate": {
          const key = b.dataset.key;
          let work = S.results.find((w) => paperKey(w) === key);
          const pathIndex = Number(b.dataset.paperIndex); if (!work && Number.isInteger(pathIndex)) work = S.pathResults?.[pathIndex]?.paper;
          const record = S.candidates.find((c) => c.paper_key === key) || candidateFor(work);
          work ||= record?.paper;
          if (!work) throw new Error("找不到這篇論文資料，請重新搜尋後操作。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
          if (b.disabled) return;
          b.disabled = true; b.textContent = record ? "正在移出…" : "正在加入…"; /* i18n-dom: shared DOM translator localizes rendered UI text. */
          try {
            await PR.api(API + "/candidate", { method: "POST", body: { action: record ? "remove" : "add", paper: work } });
            S.candidates = (await PR.api(API)).candidates || [];
          } catch (error) { b.disabled = false; b.textContent = record ? "移出候選" : "加入候選"; throw error; } /* i18n-dom: shared DOM translator localizes rendered UI text. */
          PR.toast(record ? "已從候選清單移除。" : "已加入候選清單，摘要會在背景自動整理。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
          return renderActive();
        }
        case "remove-candidate": {
          const record = S.candidates.find((c) => c.paper_key === b.dataset.key); if (!record) return;
          await PR.api(API + "/candidate", { method: "POST", body: { action: "remove", paper: record.paper } });
          S.candidates = (await PR.api(API)).candidates || []; return renderCandidates();
        }
        case "candidate-summary": S.summaryKey = b.dataset.key; S.forceSummary = b.dataset.forceSummary === "1"; return aiSummary();
        case "retry-summary": {
          const record = S.candidates.find((c) => c.paper_key === b.dataset.key); if (!record) return;
          b.disabled = true; b.innerHTML = '<i class="spin"></i> 已重新排入…'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
          await PR.api(API + "/candidate", { method: "POST", body: { action: "retry-summary", paper: record.paper } });
          S.candidates = (await PR.api(API)).candidates || S.candidates; return renderCandidates();
        }
        case "view-summary": { const record = S.summaries.find((x) => x.paper_key === b.dataset.key) || S.candidates.find((c) => c.paper_key === b.dataset.key); if (record?.summary_markdown) showSummary(record); return; }
        case "download-summary": { const record = S.summaries.find((x) => x.paper_key === b.dataset.key) || S.candidates.find((c) => c.paper_key === b.dataset.key); if (record?.summary_markdown) await exportMarkdown(paperExportStem(record) + "-summary.md", record.summary_markdown); return; }
        case "trash-summary": {
          const record = S.summaries.find((x) => x.paper_key === b.dataset.key); if (!record) return;
          if (!(await PR.confirm({ title: "將摘要移到回收站？", body: "摘要會從「已整理摘要」移除，可在文獻庫的回收站還原。論文與閱讀資料不會受到影響。", ok: "移到回收站", danger: true, at: b }))) return; /* i18n-dom: shared DOM translator localizes rendered UI text. */
          b.disabled = true;
          try { await PR.api("/api/trash", { method: "POST", body: { action: "move-summary", type: "summary", name: record.paper_key } }); }
          catch (error) { b.disabled = false; throw error; }
          S.summaries = S.summaries.filter((x) => x.paper_key !== record.paper_key);
          renderSummaries(); PR.toast("摘要已移到回收站。"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
          try { const updated = await PR.api(API); S.candidates = updated.candidates || S.candidates; }
          catch (_) { /* The completed move remains reflected in the current view. */ }
          return;
        }
        case "select-path-goal": {
          const selected = pathGoalOptions().find((item) => item.id === b.dataset.goal);
          if (!selected) return;
          S.pathGoalPreset = selected.id;
          S.pathGoal = selected.value;
          return renderPath();
        }
        case "path-toggle-settings": S.pathConfigOpen = !S.pathConfigOpen; return renderPath();
        case "path-view": S.pathView = b.dataset.pathView === "list" ? "list" : "map"; return renderPath();
        case "path-toggle-sequence": S.pathShowSequence = !S.pathShowSequence; return renderPath();
        case "path-toggle-relations": {
          S.pathShowRelations = !S.pathShowRelations;
          if (S.pathShowRelations && !S.pathRelations.length && !S.pathRelationError) return updatePathRelations();
          return renderPath();
        }
        case "path-refresh-relations": return updatePathRelations();
        case "path-select-paper": S.pathSelectedKey = b.dataset.pathKey || ""; return renderPath();
        case "path-move-paper": return movePathPaper(b.dataset.pathKey || "", Number(b.dataset.direction || 0));
        case "path-zoom": {
          const current = Number(S.pathMapView.scale || 1), factor = b.dataset.zoom === "in" ? 1.18 : 1 / 1.18;
          S.pathMapView = { ...S.pathMapView, scale: Math.max(.55, Math.min(1.8, current * factor)) }; return renderPath();
        }
        case "path-fit": S.pathMapView = { scale: 1, panX: 0, panY: 0 }; return renderPath();
        case "generate-path": return generatePath();
        case "rewrite-selected": return rewriteSelected();
        case "publication-check": {
          b.disabled = true; b.textContent = "正在核對 DOI…"; /* i18n-dom: shared DOM translator localizes rendered UI text. */
          try {
            const record = await PR.api(API + "/publication-check?doi=" + encodeURIComponent(b.dataset.doi));
            const body = '<dl class="rw-publication-data"><dt>Crossref 登錄標題</dt><dd>' + titleHtml(record.title || "未提供") + '</dd><dt>出版來源</dt><dd>' + esc(record.container_title || "未提供") + '</dd><dt>資料類型</dt><dd>' + esc(record.type || "未提供") + '</dd><dt>出版年份</dt><dd>' + esc(record.year || "未提供") + '</dd><dt>DOI</dt><dd>' + esc(record.doi) + '</dd></dl><p class="rw-source">Crossref 書目紀錄可協助核對 DOI、刊名與資料類型；仍需依會議官方紀錄確認正式發表狀態。</p>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
            openModal("DOI／出版資料核對", body, async () => {}, "關閉"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
          } catch (error) { PR.toast(PR.t("Crossref 核對失敗：{message}", { message: PR.t(error.message) })); }
          finally { b.disabled = false; b.textContent = "核對 DOI 出版資料"; } /* i18n-dom: shared DOM translator localizes rendered UI text. */
          return;
        }
        case "relation": return relations(b);
        case "explore-relation": {
          const wid = b.dataset.work, title = b.dataset.title || "", doi = b.dataset.doi || "";
          return loadRelation(wid, "related", title, doi);
        }
        case "change-relation": {
          const rel = b.dataset.relation;
          if (!S.relationRequest) return;
          return loadRelation(S.relationRequest.id, rel, S.relationRequest.title, S.relationRequest.doi);
        }
        case "ai-distill-keywords": {
          if (S.aiDistillBusy || !S.relationRequest?.title) return;
          S.aiDistillBusy = true;
          renderExplore();
          try {
            const res = await PR.api(API + "/ai-query", {
              method: "POST",
              body: { title: S.relationRequest.title }
            });
            const suggestions = (res.suggestions || []).map((x) => String(x || "").trim()).filter(Boolean);
            if (suggestions.length) {
              S.relationRequest.aiKeywords = suggestions;
              PR.toast(PR.t("已提煉 {count} 組主題關鍵字。", { count: suggestions.length }));
            } else {
              PR.toast(PR.t("未能提煉出更多關鍵字，建議直接使用現有標題搜尋。"));
            }
          } catch (err) {
            PR.toast(PR.t("AI 關鍵字提煉失敗：{message}", { message: PR.t(err.message) }));
          } finally {
            S.aiDistillBusy = false;
            renderExplore();
          }
          return;
        }
        case "switch-to-topic-search": {
          const title = S.relationRequest?.title || S.query || "";
          S.relation = false;
          S.relationRequest = null;
          S.mode = "topic";
          S.query = cleanTopicQuery(title);
          renderExplore();
          return search();
        }
        case "skip": await PR.api(API + "/skip", { method: "POST", body: { paper_key: b.dataset.key } }); S.results = S.results.filter((w) => paperKey(w) !== b.dataset.key); return renderExplore();
        case "attach-pdf": return attachPdf(b.dataset.key);
        case "retry-pdf": await PR.api(API + "/retry-pdf", { method: "POST", body: { paper_key: b.dataset.key } }); PR.toast("已重新排入 PDF 下載。"); return init(); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
        case "interested": { const task = allTasks().find((x) => x.id === b.dataset.taskId); if (task) { const interested = !task.interested; return patchTask(task, { interested, starred: interested }); } break; }
        case "archive-task": {
          const task = allTasks().find((x) => x.id === b.dataset.taskId);
          if (task) {
            await patchTask(task, { archived: true });
            PR.toast(PR.t("已移至封存區"));
          }
          break;
        }
        case "ai-summary": return aiSummary();
        case "ai-query": return aiQuery();
        case "apply-single-kw": {
          const kw = b.dataset.kw;
          if (!kw) return;
          const modal = $("#rw-modal");
          if (modal) modal.hidden = true;
          S.relation = false;
          S.relationRequest = null;
          S.mode = "topic"; S.query = kw; S.results = []; renderExplore(); return search();
        }
        case "next-page": {
          return loadMore(b);
        }
      }
    } catch (err) { PR.toast(esc(err.message)); }
  });
  document.addEventListener("submit", (e) => { if (e.target.id === "rw-search") { e.preventDefault(); search(); } });
  document.addEventListener("input", (e) => {
    const fields = { "rw-query": "query", "rw-venue-query": "venueQuery", "rw-year-from": "yearFrom", "rw-year-to": "yearTo", "rw-sort": "exploreSort" };
    const key = fields[e.target.id];
    if (key) S[key] = e.target.value;
    if (e.target.id === "rw-oa") S.onlyOA = e.target.checked;
    if (e.target.matches("[data-compare-focus]")) S.compareFocus = e.target.value;
    if (e.target.matches("[data-compare-custom]")) S.compareCustomDimension = e.target.value;
  });
  document.addEventListener("focusout", (e) => { if (S.pendingRender && e.target.closest(".rw-view") && !$(".rw-modal:not([hidden])")) { S.pendingRender = false; renderActive(); } });
  document.addEventListener("change", async (e) => {
    const c = e.target;
    if (["rw-query", "rw-venue-query", "rw-year-from", "rw-year-to", "rw-sort"].includes(c.id)) rememberExploreInputs();
    if (c.id === "rw-oa") S.onlyOA = c.checked;
    if (c.matches("[data-keyword-id]")) {
      c.checked ? S.keywordSelected.add(c.dataset.keywordId) : S.keywordSelected.delete(c.dataset.keywordId);
      await loadKeywordMatches(); return renderKeywords();
    }
    if (c.matches("[data-keyword-archived]")) { S.keywordArchived = c.checked; return loadKeywords(false); }
    if (c.matches("[data-keyword-manual]")) { S.keywordManual = c.checked; await loadKeywordMatches(); return renderKeywords(); }
    if (c.matches("[data-select-work]")) { c.checked ? S.checked.add(c.dataset.selectWork) : S.checked.delete(c.dataset.selectWork); return; }
    if (c.matches("[data-compare-dimension]")) {
      c.checked ? S.compareDimensions.add(c.dataset.compareDimension) : S.compareDimensions.delete(c.dataset.compareDimension);
      return renderComparisons();
    }
    if (c.matches("[data-compare-paper]")) {
      if (c.checked && S.compareSelection.size >= 5) { c.checked = false; return PR.toast(PR.t("最多選擇 5 篇論文。")); }
      c.checked ? S.compareSelection.add(c.dataset.comparePaper) : S.compareSelection.delete(c.dataset.comparePaper);
      return renderComparisons();
    }
    if (c.matches("[data-source-choice]")) {
      const id = c.dataset.sourceChoice, source = S.venueOptions.find((s) => s.id === id);
      rememberExploreInputs();
      S.venueSelected = S.venueSelected.filter((s) => s.id !== id);
      if (c.checked && source) S.venueSelected.push(source);
      return renderExplore();
    }
    if (c.matches("[data-filter]")) { const k = c.dataset.filter; S.filters[k] = c.type === "checkbox" ? c.checked : c.value; renderBoard(); return; }
    if (c.matches("[data-sort]")) { S.sort = c.value; renderBoard(); return; }
  });
  document.addEventListener("keydown", async (e) => {
    if (!e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key) || e.target.closest("a,button,input,select,textarea")) return;
    const card = e.target.closest(".rw-task[data-task]"); if (!card) return;
    const columns = Array.from(document.querySelectorAll(".rw-column")), current = card.closest(".rw-column");
    const index = columns.indexOf(current), next = columns[index + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    const task = allTasks().find((item) => item.id === card.dataset.task); if (!task) return;
    e.preventDefault();
    const destination = next.dataset.column;
    const order = allTasks().filter((item) => (item.status || "unread") === destination).length * 100 + 100;
    try { await patchTask(task, { status: destination, manual_order: order }); PR.toast(PR.t("閱讀狀態已移至「{status}」。", { status: PR.t(statusLabel(destination)) })); }
    catch (error) { PR.toast(PR.t(error.message)); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.altKey || !["Enter", " "].includes(e.key) || e.target.closest("a,button,input,select,textarea,label")) return;
    const card = e.target.closest(".rw-task[data-task]");
    if (!card || S.tab !== "board") return;
    e.preventDefault(); openQuickPeek(card.dataset.task, card);
  });
  document.addEventListener("input", (e) => {
    if (e.target?.id === "rw-path-topic") S.pathTopic = e.target.value;
    if (e.target?.id === "rw-path-goal") {
      S.pathGoal = e.target.value;
      S.pathGoalPreset = pathGoalOptions().find((item) => item.value === e.target.value)?.id || "custom";
    }
  });
  let dragged = null, suppressQuickPeekUntil = 0;
  document.addEventListener("dragstart", (e) => { const task = e.target.closest("[data-task]"); if (!task) return; suppressQuickPeekUntil = Date.now() + 350; dragged = task.dataset.task; e.dataTransfer.setData("text/plain", dragged); e.dataTransfer.effectAllowed = "move"; });
  document.addEventListener("dragover", (e) => { const col = e.target.closest("[data-column]"); if (!col || !dragged) return; e.preventDefault(); col.classList.add("drop-target"); });
  document.addEventListener("dragleave", (e) => { const col = e.target.closest("[data-column]"); if (col && !col.contains(e.relatedTarget)) col.classList.remove("drop-target"); });
  document.addEventListener("drop", async (e) => {
    const col = e.target.closest("[data-column]"); if (!col || !dragged) return; e.preventDefault(); col.classList.remove("drop-target");
    const task = allTasks().find((x) => x.id === dragged); const targetCard = e.target.closest("[data-task]"); if (!task) return;
    const destination = col.dataset.column; let rollback = [{ item: task, status: task.status || "unread", manual_order: task.manual_order || 0 }];
    try {
      if (targetCard && targetCard.dataset.task !== dragged) {
        const group = allTasks().filter((x) => (x.status || "unread") === destination && x.id !== dragged).sort((a, b) => Number(a.manual_order || 0) - Number(b.manual_order || 0));
        rollback = [task, ...group].map((item) => ({ item, status: item.status || "unread", manual_order: item.manual_order || 0 }));
        const at = group.findIndex((x) => x.id === targetCard.dataset.task);
        group.splice(at < 0 ? group.length : at, 0, task);
        await Promise.all(group.map((x, index) => saveTaskFields(x, { status: destination, manual_order: (index + 1) * 100 })));
        S.sort = "manual";
        const data = await PR.api(API); S.items = data.items || S.items; S.saved = data.saved || S.saved; renderBoard();
      } else {
        const group = allTasks().filter((x) => (x.status || "unread") === destination && x.id !== dragged).sort((a, b) => Number(a.manual_order || 0) - Number(b.manual_order || 0));
        rollback = [task, ...group].map((item) => ({ item, status: item.status || "unread", manual_order: item.manual_order || 0 }));
        await saveTaskFields(task, { status: destination, manual_order: (group.length + 1) * 100 });
        S.sort = "manual";
        const data = await PR.api(API); S.items = data.items || S.items; S.saved = data.saved || S.saved; renderBoard();
      }
    } catch (err) {
      const restored = await Promise.allSettled(rollback.map((x) => saveTaskFields(x.item, { status: x.status, manual_order: x.manual_order })));
      try { const data = await PR.api(API); S.items = data.items || S.items; S.saved = data.saved || S.saved; renderBoard(); } catch (_) { /* retain the last rendered board while the service reconnects */ }
      const fullyRestored = restored.every((x) => x.status === "fulfilled");
      PR.toast(fullyRestored ? "拖曳未能儲存，已還原原排序。" : "拖曳未能儲存；連線恢復後請確認排序。" ); // i18n-ok: 研究工作區依產品規格固定使用繁體中文。
    }
    dragged = null;
  });
  const searchParams = new URLSearchParams(location.search);
  if (searchParams.get("mode") === "conference") S.mode = "conference";
  if (searchParams.get("mode") === "path") S.tab = "path";
  if (searchParams.get("mode") === "candidates") S.tab = "candidates";
  if (searchParams.get("mode") === "comparisons") S.tab = "comparisons";
  if (searchParams.get("mode") === "keywords") { S.tab = "keywords"; S.keywordSelected = new Set((searchParams.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 50)); }
  if (searchParams.get("mode") === "relation") {
    S.tab = "explore";
    const work = searchParams.get("work") || searchParams.get("id") || "";
    const rel = searchParams.get("relation") || "related";
    const startTitle = searchParams.get("start_title") || searchParams.get("title") || "";
    const startDoi = searchParams.get("start_doi") || searchParams.get("doi") || "";
    if (work || startDoi || startTitle) {
      S.relationTarget = { id: work || (startDoi ? "doi:" + startDoi : startTitle), relation: rel, title: startTitle, doi: startDoi };
    }
  } else if (searchParams.has("q") && !["path", "candidates", "comparisons"].includes(searchParams.get("mode"))) {
    S.tab = "explore";
  }
  if (searchParams.get("q")) S.query = cleanTopicQuery(searchParams.get("q"));
  if (S.tab === "comparisons" && searchParams.get("papers")) {
    S.compareSelection = new Set(searchParams.get("papers").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 5));
    S.compareSetupOpen = S.compareSelection.size > 0;
  }
  init();
})(window.PR);
