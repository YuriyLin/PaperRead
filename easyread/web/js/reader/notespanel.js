/* 右侧笔记面板：全部批注按原文顺序排好（可筛选、可就地编辑），以及整篇的“论文笔记”。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let tab = PR.ls && PR.ls.get ? PR.ls.get("easyread-np-tab", "notes") : "notes";
  let filter = "all";
  let editing = null;
  const panel = () => PR.$("#notespanel");

  PR.notesPanelOpen = () => PR.side === "notes";
  PR.toggleNotesPanel = function (force) {
    const open = force != null ? force : PR.side !== "notes";
    PR.openSide(open ? "notes" : null);
    if (open) PR.renderNotesPanel();
    else editing = null;
  };

  PR.openPaperNotes = function () {
    if (editing) stopEditing();
    tab = "paper";
    PR.ls && PR.ls.set && PR.ls.set("easyread-np-tab", "paper");
    PR.toggleNotesPanel(true);
    PR.renderNotesPanel();
  };

  function sectionOf(id) {
    let cur = null;
    for (const b of S.paper.blocks || []) {
      if (b.type === "heading" || b.type === "references") cur = b;
      if (b.id === id) break;
    }
    return cur ? (cur.num ? cur.num + " " : "") + PR.plain(PR.textFor(cur.id) || cur.zh) : PR.t("论文开头");
  }
  PR.sectionOf = sectionOf;

  function items() {
    const replied = new Set((S.discussion.entries || []).map((e) => e.reply_to).filter(Boolean));
    const out = [];
    for (const n of PR.myNotes()) out.push({ src: "mine", anchor: n.anchor || "head", t: n.created || "", data: n });
    for (const e of S.discussion.entries || []) out.push({ src: "agent", anchor: PR.anchorOfEntry(e), t: e.at || "", data: e });
    const keep = {
      all: () => true, mine: (i) => i.src === "mine" && i.data.kind !== "highlight", agent: (i) => i.src === "agent",
      hl: (i) => i.src === "mine" && i.data.quote, open: (i) => i.src === "mine" && i.data.kind === "question" && !replied.has(i.data.id),
    }[filter];
    const order = (a) => (a === "head" ? -1 : PR.order[a] ?? 1e9);
    return out.filter(keep).sort((a, b) => order(a.anchor) - order(b.anchor) || (a.t < b.t ? -1 : 1));
  }

  let smartJob = null;
  function getBlockIndex(anchor) {
    if (!anchor) return 999999;
    const blocks = (PR.paper && PR.paper.blocks) || [];
    const idx = blocks.findIndex((b) => b && b.id === anchor);
    return idx >= 0 ? idx : 999999;
  }

  const smartItems = () => {
    const list = Object.values(S.reader.ai_annotations || {}).filter((a) => ["pending", "edited"].includes(a.status));
    return list.sort((a, b) => {
      const pageA = a.page != null ? Number(a.page) : 9999;
      const pageB = b.page != null ? Number(b.page) : 9999;
      if (pageA !== pageB) return pageA - pageB;
      const idxA = getBlockIndex(a.anchor);
      const idxB = getBlockIndex(b.anchor);
      if (idxA !== idxB) return idxA - idxB;
      return (a.created_at || "").localeCompare(b.created_at || "");
    });
  };

  function updateSmartNotesIndicator(running) {
    const btn = PR.$ && PR.$('#bar [data-act="notes"]');
    if (btn) {
      if (running) {
        btn.classList.add("is-running");
      } else if (!PR.noteHelpRunning || !PR.noteHelpRunning()) {
        btn.classList.remove("is-running");
      }
    }
  }
  const smartSections = () => (PR.headings || []).filter((h) => h && h.id).map((h) => ({ id: h.id, label: (h.num ? h.num + " " : "") + PR.plain(PR.textFor(h.id) || h.zh || h.en || "") }));

  function smartColorLegend() {
    const highlighters = [
      ["yellow", PR.t("核心主張"), PR.t("標記完整的重要句子、核心論點與結論")],
      ["green", PR.t("方法與證據"), PR.t("標記研究方法、實驗架構與關鍵結果")],
      ["blue", PR.t("背景知識"), PR.t("標記重要背景、問題定義與領域概念")],
      ["pink", PR.t("研究限制"), PR.t("標記研究限制、瓶頸、缺陷與待解問題")],
    ];
    const underlines = [
      ["yellow", PR.t("關鍵詞"), PR.t("標記核心概念、專有名詞與新術語")],
      ["green", PR.t("數據指標"), PR.t("標記數值、統計指標、百分比與實驗數據")],
      ["blue", PR.t("引用來源"), PR.t("標記作者、理論名稱、基準模型與文獻")],
      ["pink", PR.t("疑點與風險"), PR.t("標記不確定性、矛盾語句與潛在風險")],
    ];

    const renderPills = (list, isUnderline) =>
      list.map(([color, semLabel, desc]) =>
        '<span class="smart-pill" title="' + PR.esc(desc) + '">' +
        (isUnderline
          ? '<span class="smart-bar ul-' + color + '"></span>'
          : '<span class="smart-dot hl-' + color + '"></span>') +
        '<span>' + PR.esc(semLabel) + '</span>' +
        '<span class="smart-info-tip" aria-label="' + PR.esc(desc) + '">i</span>' +
        '</span>'
      ).join("");

    return '<div class="smart-legend-box">' +
      '<div class="smart-legend-head">' +
      '<span class="smart-legend-title">' + PR.t("標註規則圖例") + '</span>' +
      '</div>' +
      '<div class="smart-legend-body">' +
      '<div class="smart-legend-group">' +
      '<div class="smart-legend-subhead">' + PR.t("螢光筆（句子）") + '</div>' +
      '<div class="smart-legend-grid">' + renderPills(highlighters, false) + '</div>' +
      '</div>' +
      '<div class="smart-legend-group">' +
      '<div class="smart-legend-subhead">' + PR.t("底線筆（短語）") + '</div>' +
      '<div class="smart-legend-grid">' + renderPills(underlines, true) + '</div>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  function smartDialog() {
    const dlg = PR.$("#readerDlg");
    const sections = smartSections();
    dlg.querySelector(".dialog").innerHTML = '<h2>' + PR.t("智慧標註") + '</h2>' +
      '<div class="smart-alert-banner">' +
      '<span class="smart-alert-icon">ℹ</span>' +
      '<span>' + PR.t("先產生待確認建議；接受後才會套用到正文，不會覆蓋手動標註。") + '</span>' +
      '</div>' +
      smartColorLegend() +
      '<div class="smart-form-section">' +
        '<div class="smart-form-group">' +
          '<label class="smart-group-label">' + PR.t("劃記強度") + '</label>' +
          '<input type="hidden" id="smartIntensity" value="standard">' +
          '<div class="smart-segmented" role="radiogroup" aria-label="' + PR.esc(PR.t("劃記強度")) + '">' +
            '<button type="button" class="smart-seg-btn" data-seg="smartIntensity" data-val="concise" title="' + PR.esc(PR.t("每段只保留最有價值的資訊，適合快速閱讀")) + '">' +
              '<span class="seg-title">' + PR.t("精簡") + '</span>' +
              '<span class="seg-sub">' + PR.t("快速閱讀") + '</span>' +
            '</button>' +
            '<button type="button" class="smart-seg-btn active" data-seg="smartIntensity" data-val="standard" title="' + PR.esc(PR.t("保留各類重要資訊與核心詞彙，適合一般研究")) + '">' +
              '<span class="seg-title">' + PR.t("標準") + '</span>' +
              '<span class="seg-sub">' + PR.t("一般研究") + '</span>' +
            '</button>' +
            '<button type="button" class="smart-seg-btn" data-seg="smartIntensity" data-val="detailed" title="' + PR.esc(PR.t("增加次要證據與詳細數據，適合深入研究")) + '">' +
              '<span class="seg-title">' + PR.t("詳細") + '</span>' +
              '<span class="seg-sub">' + PR.t("深入研究") + '</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="smart-form-row">' +
          '<div class="smart-form-col">' +
            '<div class="smart-label-wrap">' +
              '<label class="smart-group-label" for="smartMode">' + PR.t("分析模式") + '</label>' +
              '<button type="button" class="smart-help-btn" data-smart-mode-help title="' + PR.esc(PR.t("說明三種標註模式的差異")) + '" aria-label="' + PR.esc(PR.t("說明三種標註模式的差異")) + '">' +
                PR.icon("question", "sm") +
              '</button>' +
            '</div>' +
            '<select id="smartMode" class="smart-select">' +
              '<option value="auto">' + PR.t("AI 自動標註") + '</option>' +
              '<option value="suggest">' + PR.t("AI 建議標註") + '</option>' +
              '<option value="purpose">' + PR.t("依研究目的標註") + '</option>' +
            '</select>' +
          '</div>' +
          '<div class="smart-form-col">' +
            '<label class="smart-group-label">' + PR.t("分析範圍") + '</label>' +
            '<input type="hidden" id="smartScope" value="all">' +
            '<div class="smart-segmented" role="radiogroup" aria-label="' + PR.esc(PR.t("分析範圍")) + '">' +
              '<button type="button" class="smart-seg-btn active" data-seg="smartScope" data-val="all">' +
                '<span class="seg-title">' + PR.t("全文") + '</span>' +
              '</button>' +
              '<button type="button" class="smart-seg-btn" data-seg="smartScope" data-val="section">' +
                '<span class="seg-title">' + PR.t("指定章節") + '</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<section id="smartModeHelp" class="smart-mode-help" role="region" hidden>' +
          '<div class="smart-mode-help-head">' +
            '<b>' + PR.t("分析模式差異說明") + '</b>' +
            '<button type="button" class="smart-help-close" data-smart-mode-help-close aria-label="' + PR.t("關閉模式說明") + '">×</button>' +
          '</div>' +
          '<dl class="smart-mode-dl">' +
            '<dt>' + PR.t("AI 自動標註") + '</dt>' +
            '<dd>' + PR.t("由 AI 全面均衡分析全文，自動發掘最重要的核心主張、方法、關鍵詞與數據指標。") + '</dd>' +
            '<dt>' + PR.t("AI 建議標註") + '</dt>' +
            '<dd>' + PR.t("側重標註研究方法、架構設計、實驗結果與文獻引用，適合深化技術細節。") + '</dd>' +
            '<dt>' + PR.t("依研究目的標註") + '</dt>' +
            '<dd>' + PR.t("依讀者自訂的研究目的（在下方輸入框填寫）進行聚焦定向標記，精準過濾相關內容。") + '</dd>' +
          '</dl>' +
        '</section>' +
        '<div class="smart-field smart-section-field" hidden>' +
          '<label class="smart-group-label" for="smartSection">' + PR.t("章節") + '</label>' +
          '<select id="smartSection" class="smart-select">' + sections.map((s) => '<option value="' + PR.esc(s.id) + '">' + PR.esc(s.label) + '</option>').join("") + '</select>' +
        '</div>' +
        '<div class="smart-field smart-purpose-field">' +
          '<label class="smart-group-label" for="smartPurpose">' + PR.t("研究目的（可選）") + '</label>' +
          '<textarea id="smartPurpose" rows="2" class="smart-textarea" placeholder="' + PR.esc(PR.t("例如：找出可用於 3D segmentation 的方法與限制")) + '"></textarea>' +
        '</div>' +
      '</div>' +
      '<div class="actions"><button class="btn" data-smart-close>' + PR.t("取消") + '</button><button class="btn primary" data-smart-start>' + PR.t("開始分析") + '</button></div>';
    dlg.classList.add("open");

    const section = dlg.querySelector(".smart-section-field");
    dlg.querySelectorAll(".smart-seg-btn").forEach((btn) => {
      btn.onclick = () => {
        const targetId = btn.dataset.seg;
        const val = btn.dataset.val;
        btn.closest(".smart-segmented").querySelectorAll(".smart-seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const inp = dlg.querySelector("#" + targetId);
        if (inp) inp.value = val;
        if (targetId === "smartScope" && section) {
          section.hidden = (val !== "section");
        }
      };
    });
    const modeSelect = dlg.querySelector("#smartMode");
    const purposeTextarea = dlg.querySelector("#smartPurpose");
    if (modeSelect && purposeTextarea) {
      modeSelect.onchange = () => {
        if (modeSelect.value === "purpose") {
          purposeTextarea.focus();
        }
      };
    }
    const modeHelpBtn = dlg.querySelector("[data-smart-mode-help]");
    const modeHelpBox = dlg.querySelector("#smartModeHelp");
    const modeHelpClose = dlg.querySelector("[data-smart-mode-help-close]");
    if (modeHelpBtn && modeHelpBox) {
      modeHelpBtn.onclick = () => {
        const isHidden = modeHelpBox.hidden;
        modeHelpBox.hidden = !isHidden;
        modeHelpBtn.classList.toggle("active", isHidden);
      };
    }
    if (modeHelpClose && modeHelpBox) {
      modeHelpClose.onclick = () => {
        modeHelpBox.hidden = true;
        modeHelpBtn?.classList.remove("active");
      };
    }
  }

  function smartCard(a) {
    const isUnderline = a.style === "underline" || a.type === "underline";
    const label = isUnderline ? PR.t("底線") : PR.t("螢光筆");
    const color = a.color === "pink" ? PR.t("紅") : (PR.HL_COLORS.find(([key]) => key === a.color) || ["", a.color || PR.t("黃")])[1];
    const semanticRole = isUnderline ? ({
      yellow: PR.t("關鍵詞"),
      green: PR.t("數據指標"),
      blue: PR.t("引用來源"),
      pink: PR.t("疑點與風險"),
    }[a.color] || PR.t("關鍵詞")) : ({
      yellow: PR.t("核心主張"),
      green: PR.t("方法與證據"),
      blue: PR.t("背景知識"),
      pink: PR.t("研究限制"),
    }[a.color] || PR.t("核心主張"));
    const location = a.locatable ? (a.page ? PR.t("第 {page} 頁", { page: a.page }) : PR.t("已定位")) :
      (a.stale_reason === "translation_changed" ? PR.t("譯文已更新，請重新分析") :
        (a.source_stale ? PR.t("來源已更新，請重新分析") : PR.t("無法定位，請修改原文")));

    const overlapBadge = a.manual_overlap
      ? '<span class="smart-badge smart-badge-overlap" title="' + PR.esc(PR.t("與手動劃記重疊（{quote}）", { quote: a.overlap_quote || "" })) + '">' + PR.t("與手動劃記重疊") + '</span>'
      : '';

    let actionsHtml = '';
    if (a.manual_overlap) {
      actionsHtml = '<button class="btn sm warning" data-smart-action="accept" title="' + PR.esc(PR.t("保留此 AI 標註，與既有手動標註並存")) + '">' + PR.t("保留重疊") + '</button>' +
        '<button class="btn sm line" data-smart-action="reject" title="' + PR.esc(PR.t("略過此重疊標註")) + '">' + PR.t("略過") + '</button>' +
        '<button class="btn sm line" data-smart-action="edit">' + PR.t("修改") + '</button>';
    } else {
      actionsHtml = '<button class="btn sm primary" data-smart-action="accept"' + (a.locatable ? "" : " disabled") + '>' + PR.t("接受") + '</button>' +
        '<button class="btn sm line" data-smart-action="edit">' + PR.t("修改") + '</button>' +
        '<button class="btn sm line danger" data-smart-action="reject">' + PR.t("拒絕") + '</button>';
    }

    return '<article class="smart-card' + (a.locatable ? "" : " smart-unlocatable") + (a.manual_overlap ? " smart-overlap" : "") + '" data-smart-id="' + PR.esc(a.annotation_id) + '" data-anchor="' + PR.esc(a.anchor || "") + '">' +
      '<div class="smart-card-head"><span class="smart-tag smart-tag-' + PR.esc(a.color) + (isUnderline ? ' is-underline' : '') + '">' + PR.esc(semanticRole) + '</span>' + overlapBadge + '<span class="grow"></span><span class="smart-meta">' + PR.esc(color) + " · " + PR.esc(label) + " · " + PR.esc(location) + '</span></div>' +
      (a.manual_overlap ? '<div class="smart-overlap-hint">' + PR.esc(PR.t("偵測到此處已存在手動劃記：「{quote}」。AI 不會覆蓋您的劃記，您可以決定是否保留此重疊建議。", { quote: a.overlap_quote || "" })) + '</div>' : '') +
      '<blockquote class="smart-quote' + (isUnderline ? ' smart-quote-underline' : '') + '">' + PR.md(a.quote || PR.t("沒有可顯示的原文"), { cite: false, xref: false }) + '</blockquote>' +
      (a.note ? '<p class="smart-note"><b>' + PR.t("AI 註記") + '</b> ' + PR.mdBlocks(a.note) + '</p>' : '') +
      (a.reason ? '<p class="smart-reason"><b>' + PR.t("標註原因") + '</b> ' + PR.esc(a.reason) + '</p>' : '') +
      '<div class="smart-actions">' + actionsHtml + '</div></article>';
  }

  function smartHtml() {
    const list = smartItems();
    const locatableList = list.filter((a) => a.locatable);
    const overlapCount = locatableList.filter((a) => a.manual_overlap).length;
    const cleanCount = locatableList.filter((a) => !a.manual_overlap).length;
    const running = smartJob && ["queued", "running"].includes(smartJob.state);
    const progressText = running
      ? (smartJob.total > 0
          ? PR.t("正在分析論文（第 {done} / {total} 批）…", { done: Math.min((smartJob.done || 0) + 1, smartJob.total), total: smartJob.total })
          : PR.t("正在分析論文，完成後會顯示待確認項目…"))
      : "";

    let batchButtons = '';
    if (running) {
      batchButtons = '<button class="btn sm line" data-smart-cancel>' + PR.t("取消分析") + '</button>';
    } else if (list.length > 0) {
      if (cleanCount > 0) {
        batchButtons += '<button class="btn sm primary" data-smart-action="accept-all" title="' + PR.esc(PR.t("僅接受無手動衝突的標註")) + '">' + (overlapCount > 0 ? PR.t("批次接受（{n} 筆非重疊）", { n: cleanCount }) : PR.t("批次接受")) + '</button>';
      }
      if (overlapCount > 0) {
        batchButtons += '<button class="btn sm warning line" data-smart-action="accept-all-overlap" title="' + PR.esc(PR.t("包含與手動劃記重疊的標註一併接受")) + '">' + PR.t("全部接受（含重疊 {n} 筆）", { n: overlapCount }) + '</button>';
        batchButtons += '<button class="btn sm line" data-smart-action="reject-overlaps" title="' + PR.esc(PR.t("略過所有與手動劃記重疊的建議")) + '">' + PR.t("略過重疊") + '</button>';
      }
      batchButtons += '<button class="btn sm line danger" data-smart-action="reject-all">' + PR.t("批次拒絕") + '</button>';
    }

    let h = '<section class="np-smart"><div class="np-smart-head"><div><b>' + PR.t("AI 待確認標註") + '</b><span class="smart-count">' + list.length + '</span></div><span class="grow"></span>' +
      batchButtons + '</div>' +
      (running ? '<p class="hint smart-progress"><span class="spin"></span> ' + progressText + '</p>' : '') +
      (list.length ? '<div class="np-smart-list">' + list.map(smartCard).join("") + '</div>' : '<p class="hint smart-empty">' + PR.t("尚未產生 AI 標註建議。先按「智慧標註」開始分析。") + '</p>') + '</section>';
    return h;
  }

  async function smartAction(action, id, patch, extra) {
    try {
      const body = { action, id, patch, ...(extra || {}) };
      await PR.api("/api/p/" + encodeURIComponent(PR.pid) + "/smart-annotation", { method: "POST", body });
      await PR.poll();
      PR.renderNotesPanel();
      if (action === "accept" || action === "accept_all") { PR.applyMarks(); PR.renderMargin(); }
    } catch (error) { PR.toast(PR.t(PR.errorText(error))); }
  }

  function smartEdit(card, a) {
    PR.popover(card, '<div class="hd">' + PR.t("修改 AI 標註") + '</div>' +
      '<label class="smart-edit-field">' + PR.t("譯文定位文字") + '<textarea id="smartEditQuote" rows="3">' + PR.esc(a.quote || "") + '</textarea></label>' +
      '<label class="smart-edit-field">' + PR.t("AI 註記") + '<textarea id="smartEditNote" rows="3">' + PR.esc(a.note || "") + '</textarea></label>' +
      '<label class="smart-edit-field">' + PR.t("標註原因") + '<textarea id="smartEditReason" rows="2">' + PR.esc(a.reason || "") + '</textarea></label>' +
      '<div class="smart-edit-actions"><button class="btn sm" data-smart-edit="cancel">' + PR.t("取消") + '</button><button class="btn sm primary" data-smart-edit="save">' + PR.t("儲存修改") + '</button></div>', { sticky: true, wide: true });
    PR.$("#popover").onclick = (event) => {
      const b = event.target.closest("[data-smart-edit]");
      if (!b) return;
      if (b.dataset.smartEdit === "cancel") return PR.hidePopover();
      const value = { quote: PR.$("#smartEditQuote").value, note: PR.$("#smartEditNote").value, reason: PR.$("#smartEditReason").value };
      PR.hidePopover();
      smartAction("edit", a.annotation_id, value);
    };
  }

  PR.renderNotesPanel = function (editId) {
    if (editId !== undefined && editing && editId !== editing) stopEditing(false);
    if (editId !== undefined) { editing = editId; tab = "notes"; }
    const el = panel();
    if (editing && PR.noteMedia && PR.noteMedia.isChoosing && PR.noteMedia.isChoosing(editing) && editId === undefined) return;
    if ((editing || tab === "paper") && el.contains(document.activeElement) && document.activeElement.matches("textarea") && editId === undefined) return; // 正在打字，不打断
    if (tab === "paper" && el.querySelector(".pn-workspace")?.contains(document.activeElement) && editId === undefined) return;
    const list = items();
    const count = PR.myNotes().length + (S.discussion.entries || []).length;
    let h = '<div class="np-head"><div class="seg"><button data-np="notes" class="' + (tab === "notes" ? "on" : "") + '">' + PR.t("批注 {n}", { n: count }) + '</button><button data-np="paper" class="' + (tab === "paper" ? "on" : "") + '">' + PR.t("论文笔记") + "</button></div>" +
      '<span class="grow"></span><button class="btn sm" data-np-act="md" title="' + PR.t("导出 Markdown") + '">' + PR.t("导出") + '</button><button class="btn icon" data-np-act="close" title="' + PR.t("关闭（M）") + '">×</button></div>';
    if (tab === "paper") {
      const body = (S.reader.paper_note || {}).body || "";
      const tools = '<span class="hint">' + PR.t("整篇的感悟、总结、待办。自动保存。") + '</span><span class="grow"></span>' + PR.noteHelpButtons();
      const helper = PR.noteHelpBox();
      if (el.querySelector(".pn-workspace") && PR.paperNoteEditor.getBody() === body) {
        // 保存或 AI 状态刷新时保留编辑器实例、选择位置和撤销记录。
        el.querySelector(".np-head").outerHTML = h;
        el.querySelector(".np-tools").innerHTML = tools;
        const old = el.querySelector(".np-ai");
        if (old) { if (helper) old.outerHTML = helper; else old.remove(); }
        else if (helper) el.querySelector(".np-paper").insertAdjacentHTML("beforeend", helper);
        return;
      }
      h += '<div class="np-paper"><div class="np-tools">' + tools + '</div>' + PR.paperNoteEditor.html(body) + helper + '</div>';
    } else {
      const chips = [["all", PR.t("全部")], ["mine", PR.t("我的笔记")], ["hl", PR.t("划线")], ["agent", "AI"], ["open", PR.t("待回答")]]
        .map(([k, l]) => '<button data-nf="' + k + '" class="' + (filter === k ? "on" : "") + '">' + l + "</button>").join("");
      const checkCount = (S.discussion.entries || []).filter((entry) => entry.kind === "check").length;
      h += '<div class="np-filters">' + chips + '</div><div class="np-add"><button class="btn sm line" data-np-act="add">' + PR.icon("plus", "sm") + PR.t("给当前段写笔记") + '</button><button class="btn sm line" data-np-act="smart">' + PR.icon("sparkle", "sm") + PR.t("智慧標註") + '</button><button class="btn sm line np-clear-checks" data-np-act="clear-checks" title="' + PR.t("清除 AI 原文核對提示") + '"' + (checkCount ? "" : " disabled") + '>' + PR.t("清除核對提示") + (checkCount ? " · " + checkCount : "") + "</button></div>" + smartHtml() + '<div class="np-list">';
      let lastSec = null;
      for (const it of list) {
        const sec = it.anchor === "head" ? PR.t("论文开头") : PR.t("第 {page} 页", { page: (PR.blockById[it.anchor] || {}).page }) + " · " + sectionOf(it.anchor);
        if (sec !== lastSec) { h += '<div class="np-sec">' + PR.esc(sec) + "</div>"; lastSec = sec; }
        h += PR.cardHtml(it, editing);
      }
      if (!list.length) h += '<p class="hint np-empty">' + (filter === "all" ? PR.t("还没有批注。选中正文文字可以划线、写笔记、提问；点一下段落也能加笔记。") : PR.t("这个分类下没有内容。")) + "</p>";
      h += "</div>";
    }
    PR.paperNoteEditor?.destroy();
    el.innerHTML = h;

    PR.$$(".card textarea", el).forEach(PR.autosize);
    if (tab === "paper") PR.paperNoteEditor.mount((S.reader.paper_note || {}).body || "");
    const ta = editing && el.querySelector('.card[data-note="' + editing + '"] textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollIntoView({ block: "nearest" }); }
  };

  const savePaperNote = PR.debounce(() => {
    const ta = PR.$("#paperNote");
    if (ta && ta.value !== ((S.reader.paper_note || {}).body || "")) PR.commit({ op: "paper_note", body: ta.value });
  }, 600);
  const saveEditing = PR.debounce(() => {
    const ta = editing && panel().querySelector('.card[data-note="' + editing + '"] textarea');
    const n = editing && (S.reader.notes || {})[editing];
    if (ta && n && ta.value.trim() !== (n.body || "")) PR.saveNote(Object.assign({}, n, { body: ta.value.trim(), kind: n.kind === "highlight" && ta.value.trim() ? "note" : n.kind }));
  }, 600);
  function stopEditing(render = true) {
    const ta = editing && panel().querySelector('.card[data-note="' + editing + '"] textarea');
    const n = editing && (S.reader.notes || {})[editing];
    saveEditing.cancel();
    editing = null;
    if (ta && n) PR.finishNote(n, ta.value);
    if (render) PR.renderNotesPanel();
    PR.applyMarks();
  }
  PR.finishPanelNote = function () {
    if (editing) stopEditing(false);
    savePaperNote.flush();
  };

  panel().addEventListener("input", (e) => {
    if (e.target.id === "paperNote") {
      savePaperNote();
      PR.paperNoteEditor.update();
      const btns = PR.$("#notespanel .nh-btns");  // 笔记从空变成有内容（或反过来）：“起草稿”换成“点评 / 帮我改”
      if (btns && (btns.querySelector('[data-nh="draft"]') ? 1 : 0) !== (e.target.value.trim() ? 0 : 1)) btns.outerHTML = PR.noteHelpButtons();
    }
    else if (e.target.matches(".card textarea")) { PR.autosize(e.target); saveEditing(); }
  });
  panel().addEventListener("keydown", (e) => {
    if (e.target.matches(".card textarea") && (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey)))) { e.preventDefault(); stopEditing(); }
  });
  panel().addEventListener("focusout", (e) => {
    if (e.target.id === "paperNote" || (e.target.closest && e.target.closest(".pn-workspace"))) savePaperNote.flush();
    if (!e.target.matches || !e.target.matches(".card textarea")) return;
    setTimeout(() => { const card = e.target.closest(".card"); if (card && card.isConnected && !card.contains(document.activeElement) && editing === card.dataset.note) stopEditing(); }, 150);
  });
  panel().addEventListener("click", async (e) => {
    const np = e.target.closest("[data-np]");
    if (np) { if (editing) stopEditing(); savePaperNote.flush(); tab = np.dataset.np; PR.ls.set("easyread-np-tab", tab); return PR.renderNotesPanel(); }
    const nf = e.target.closest("[data-nf]");
    if (nf) { if (editing) stopEditing(); filter = nf.dataset.nf; return PR.renderNotesPanel(); }
    const act = e.target.closest("[data-np-act]");
    if (act) {
      const a = act.dataset.npAct;
      if (a === "close") PR.toggleNotesPanel(false);
      if (a === "md") { savePaperNote.flush(); PR.openExport(); }
      if (a === "add") { const id = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock(); if (PR.blockById[id]) PR.startNote({ anchor: id }); }
      if (a === "smart") smartDialog();
      if (a === "clear-checks") {
        const entries = S.discussion.entries || [];
        const ids = entries.filter((entry) => entry.kind === "check").map((entry) => entry.id).filter(Boolean);
        if (!ids.length || act.disabled) return;
        act.disabled = true;
        act.textContent = PR.t("清除中…");
        const removed = new Set();
        for (const id of ids) {
          try {
            await PR.api("/api/p/" + encodeURIComponent(PR.pid) + "/discussion_del", { method: "POST", body: { id } });
            removed.add(id);
          } catch (_) { /* 保留失敗項目，讓使用者可再次清除。 */ }
        }
        S.discussion.entries = entries.filter((entry) => !removed.has(entry.id));
        PR.renderMargin();
        PR.applyMarks();
        PR.renderNotesPanel();
        const failed = ids.length - removed.size;
        PR.toast(failed ? PR.t("已清除 {n} 則；另有 {failed} 則失敗，請重試。", { n: removed.size, failed }) : PR.t("已清除 {n} 則核對提示。", { n: removed.size }));
      }
      return;
    }
    const smartButton = e.target.closest("[data-smart-action]");
    if (smartButton) {
      const card = smartButton.closest("[data-smart-id]");
      const id = card && card.dataset.smartId;
      const act = smartButton.dataset.smartAction;
      if (act === "accept-all") return smartAction("accept_all", null, null, { include_overlap: false });
      if (act === "accept-all-overlap") return smartAction("accept_all", null, null, { include_overlap: true });
      if (act === "reject-overlaps") return smartAction("reject_overlaps");
      if (act === "reject-all") return smartAction("reject_all");
      const annotation = id && (S.reader.ai_annotations || {})[id];
      if (!annotation) return;
      if (act === "edit") return smartEdit(card, annotation);
      return smartAction(act, id);
    }
    const smartCardEl = e.target.closest(".smart-card");
    if (smartCardEl && !e.target.closest("button, a")) {
      if (smartCardEl.dataset.anchor) PR.jumpTo("b-" + smartCardEl.dataset.anchor);
      return;
    }
    if (e.target.closest("[data-smart-cancel]") && smartJob) {
      try { await PR.api("/api/p/" + encodeURIComponent(PR.pid) + "/smart-annotate-cancel", { method: "POST", body: { job: smartJob.id } }); }
      catch (error) { PR.toast(PR.errorText(error)); }
      smartJob = null;
      updateSmartNotesIndicator(false);
      PR.renderNotesPanel();
      return;
    }
    const card = e.target.closest(".card");
    if (!card) return;
    if (card.dataset.note && (e.target.closest(".body") || e.target.closest('[data-a="edit"]')) && !e.target.closest("a")) {
      editing = card.dataset.note; PR.renderNotesPanel(editing); return;
    }
    if (PR.cardClick(e, true)) return;
    if (card.dataset.anchor) { PR.jumpTo("b-" + card.dataset.anchor); if (card.dataset.note) setTimeout(() => PR.$$('mark[data-note="' + card.dataset.note + '"], .math-body[data-note="' + card.dataset.note + '"]').forEach((m) => m.classList.add("active")), 400); }
  });

  window.addEventListener("pagehide", () => savePaperNote.flush());
  window.addEventListener("beforeunload", () => savePaperNote.flush());
  document.addEventListener("visibilitychange", () => { if (document.hidden) savePaperNote.flush(); });

  function notifySmartComplete(job) {
    const list = smartItems();
    const count = list.length;
    const msg = count > 0
      ? PR.t("AI 標註分析完成，已產生 {count} 筆待確認標註。", { count })
      : PR.t("AI 標註分析完成，未發現高價值標註。");

    PR.toast(PR.esc(msg), count > 0 ? {
      label: PR.t("查看標註"),
      fn: () => {
        if (PR.openSide) PR.openSide("notes");
        setTimeout(() => {
          const el = PR.$(".np-smart");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 120);
      },
    } : null, 6000);

    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(PR.t("PaperRead 智慧標註完成"), {
          body: msg,
          icon: "/favicon.ico",
        });
      } catch (_) {}
    }
  }

  async function waitSmartJob(job) {
    smartJob = job;
    updateSmartNotesIndicator(true);
    PR.renderNotesPanel();
    let lastDone = job.done || 0;
    const timer = setInterval(async () => {
      try {
        const found = (await PR.api("/api/jobs?pid=" + encodeURIComponent(PR.pid))).jobs.find((item) => item.id === job.id);
        if (!found) return;
        smartJob = found;
        if ((found.done || 0) > lastDone) {
          lastDone = found.done;
          await PR.poll();
          PR.renderNotesPanel();
        }
        if (!["done", "error", "cancelled"].includes(found.state)) {
          PR.renderNotesPanel();
          return;
        }
        clearInterval(timer);
        smartJob = null;
        updateSmartNotesIndicator(false);
        await PR.poll();
        PR.renderNotesPanel();
        if (found.state === "done") {
          notifySmartComplete(found);
        } else if (found.state === "error") {
          PR.toast(PR.t("AI 標註分析失敗：{message}", { message: PR.esc(found.message || "") }));
        }
      } catch (_) { /* 下一次輪詢再試 */ }
    }, 1200);
  }

  async function syncRunningSmartJob() {
    try {
      if (!PR.pid) return;
      const data = await PR.api("/api/jobs?pid=" + encodeURIComponent(PR.pid));
      const running = (data.jobs || []).find((j) => j && j.kind === "smart-annotate" && ["queued", "running"].includes(j.state));
      if (running && (!smartJob || smartJob.id !== running.id)) {
        waitSmartJob(running);
      }
    } catch (_) {}
  }
  syncRunningSmartJob();

  PR.on && PR.on("open-smart-annotations", () => {
    if (PR.openSide) PR.openSide("notes");
    setTimeout(() => {
      const el = PR.$(".np-smart");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  });
  PR.on && PR.on("retry-smart-annotations", () => {
    smartDialog();
  });
  if (new URLSearchParams(location.search).get("open") === "smart-annotations") {
    setTimeout(() => {
      if (PR.openSide) PR.openSide("notes");
      const el = PR.$(".np-smart");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
  }

  PR.$("#readerDlg")?.addEventListener("click", async (e) => {
    if (e.target.closest("[data-smart-close]")) return PR.$("#readerDlg").classList.remove("open");
    const start = e.target.closest("[data-smart-start]");
    if (!start) return;
    try {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } catch (_) {}
    start.disabled = true;
    start.innerHTML = '<span class="spin"></span> ' + PR.t("正在送出…");
    try {
      const job = await PR.api("/api/p/" + encodeURIComponent(PR.pid) + "/smart-annotate", { method: "POST", body: {
        scope: PR.$("#smartScope").value, section_id: PR.$("#smartSection").value,
        mode: PR.$("#smartMode").value,
        intensity: PR.$("#smartIntensity") ? PR.$("#smartIntensity").value : "standard",
        purpose: PR.$("#smartPurpose").value,
      } });
      PR.$("#readerDlg").classList.remove("open");
      if (PR.researchTaskMonitor?.track) {
        PR.researchTaskMonitor.track(job, false);
      }
      await waitSmartJob(job);
    } catch (error) {
      start.disabled = false;
      start.textContent = PR.t("開始分析");
      PR.toast(PR.errorText(error));
    }
  });

  /* 导出的 Markdown：论文笔记 + 按原文顺序的批注 */
  /* pick：{paper, note, highlight, question, ai, chat, quote}，不传就全要 */
  function exportTextPair(key) {
    const [id, field] = String(key || "").split("#");
    const block = PR.blockById && PR.blockById[id];
    if (!block) return { zh: "", en: "", sents: null };
    if (field === "caption") { const edit = PR.editOf && PR.editOf(key); return { zh: edit && edit.zh != null ? edit.zh : block.caption_zh || "", en: block.caption_en || "", sents: block.sents || null }; }
    if (field === "image") { const edit = PR.editOf && PR.editOf(key); return { zh: edit && edit.zh != null ? edit.zh : block.image_zh || "", en: block.image_en || "", sents: block.sents || null }; }
    if (/^\d+$/.test(field || "")) {
      const item = (Array.isArray(block.items) ? block.items : [])[Number(field)] || {};
      const edit = PR.editOf && PR.editOf(key);
      return { zh: edit && edit.zh != null ? edit.zh : item.zh || "", en: item.en || "", sents: item.sents || null };
    }
    const edit = PR.editOf && PR.editOf(key);
    return { zh: edit && edit.zh != null ? edit.zh : block.zh || "", en: block.en || "", sents: block.sents || null };
  }

  function translatedExportQuote(item) {
    const d = item.data || {};
    if (!d.quote) return { text: "", translated: false };
    if (d.target === "formula") return { text: d.quote, translated: false, formula: true };
    const pair = exportTextPair(d.key || d.anchor);
    if (!pair.zh) return { text: d.quote, translated: false };
    // 新標註會明確記錄 side；較早的手動劃線可能沒有 side，
    // 只在引用明確出現在英文而未出現在譯文時，才把它視為英文原文。
    const isEnglish = d.side === "en" || (!d.side && pair.en && pair.en.includes(d.quote) && !pair.zh.includes(d.quote));
    if (!isEnglish) return { text: d.quote, translated: false };
    const start = pair.en.indexOf(d.quote);
    const sents = Array.isArray(pair.sents) ? pair.sents.filter((row) => Array.isArray(row) && row.length === 2) : [];
    if (start >= 0 && sents.length >= 2) {
      const end = start + d.quote.length;
      const first = sents.findIndex((row) => row[0] > start);
      const last = sents.findIndex((row) => row[0] >= end);
      if (first >= 0 && last >= 0) {
        const zhStart = first === 0 ? 0 : sents[first - 1][1];
        const zhEnd = sents[last][1];
        const text = pair.zh.slice(zhStart, zhEnd).trim();
        if (text) return { text, translated: true };
      }
    }
    // 沒有句子對齊時仍保留中文譯文，但不假裝它是精確的片語對應。
    return { text: pair.zh, translated: true };
  }

  function exportQuote(item, pick) {
    // 接受後的智慧標註已是「我的劃線」，應與手動劃線一樣可匯出；
    // 頁邊 AI 回答仍不在這裡附加引用，避免把解釋誤當成使用者劃線。
    if (!pick.quote || !item.data?.quote || item.src !== "mine") return "";
    const result = translatedExportQuote(item);
    const side = item.data.side;
    return PR.t("「{q}」", { q: result.text }) + (side === "en" ? PR.t(result.translated ? "（譯文）" : "（原文，尚無譯文對齊）") : ""); // i18n-ok: both branch labels are passed to PR.t.
  }

  function exportQuoteDetails(item, pick) {
    if (!pick.quote || !item.data?.quote || item.src !== "mine") return { text: "", label: "" };
    const result = translatedExportQuote(item);
    if (!result.text) return { text: "", label: "" };
    const side = item.data.side;
    return {
      text: result.text,
      label: result.formula ? PR.t("公式") : side === "en" ? PR.t(result.translated ? "引用（中文譯文；原始劃線為英文）" : "引用（英文原文；尚無譯文對齊）") : PR.t("引用（中文譯文）"), // i18n-ok: all export labels are passed to PR.t.
      formula: !!result.formula,
    };
  }

  function markdownLines(text, prefix) {
    return String(text || "").split("\n").map((line, index) => index ? prefix + line : line);
  }

  function mineAnnotationLines(item, pick) {
    const d = item.data || {};
    const quote = exportQuoteDetails(item, pick);
    const noteLabel = d.kind === "question" ? PR.t("我的問題") : PR.t("我的注記");
    const lines = [];
    if (quote.formula) {
      lines.push("- **" + quote.label + "**");
      lines.push("  $$", ...String(quote.text).split("\n").map((line) => "  " + line), "  $$");
      if (d.body) lines.push("  - **" + noteLabel + "：** " + markdownLines(d.body, "    ").join("\n")); // i18n-ok: Markdown formatting punctuation, not UI copy.
    } else if (quote.text) {
      lines.push("- **" + quote.label + "**");
      lines.push("  > 「" + quote.text + "」"); // i18n-ok: Markdown quote punctuation, not UI copy.
      if (d.body) lines.push("  - **" + noteLabel + "：** " + markdownLines(d.body, "    ").join("\n")); // i18n-ok: Markdown formatting punctuation, not UI copy.
    } else if (d.body) {
      lines.push("- **" + noteLabel + "：** " + markdownLines(d.body, "  ").join("\n")); // i18n-ok: Markdown formatting punctuation, not UI copy.
    }
    return lines;
  }

  PR.notesMarkdown = function (pick, chat, exportOptions) {
    pick = pick || { paper: true, note: true, highlight: true, question: true, ai: true, quote: true };
    const m = S.paper.meta || {};
    const link = m.url || (m.arxiv ? "https://arxiv.org/abs/" + String(m.arxiv).replace(/^arXiv:/i, "").split(/[\sv]/)[0] : "");
    const out = ["# " + (m.title_zh || m.title_en || ""), "", m.title_en ? "*" + m.title_en + "*  " : "", [m.authors, m.date, link].filter(Boolean).join(" · "), ""];
    if (exportOptions) {
      const pn = (S.reader.paper_note || {}).body;
      const annotations = (() => { const previousFilter = filter; filter = "all"; const all = items(); filter = previousFilter; return all; })();
      const groups = {
        note: annotations.filter((it) => it.src === "mine" && it.data.kind !== "question" && it.data.kind !== "highlight"),
        highlight: annotations.filter((it) => it.src === "mine" && it.data.kind === "highlight"),
        question: annotations.filter((it) => it.src === "mine" && it.data.kind === "question"),
        ai: annotations.filter((it) => it.src !== "mine"),
      };
      const labels = { note: PR.t("我的筆記"), highlight: PR.t("我的劃線"), question: PR.t("我的問題"), ai: PR.t("AI 的回答和解釋") };
      const order = Array.isArray(exportOptions.order) ? exportOptions.order : ["paper", "note", "highlight", "question", "ai", "chat", "mindmap", "deep_analysis"];
      for (const kind of order) {
        if (kind === "paper" && pick.paper && pn) out.push("## " + PR.t("論文筆記"), "", pn, "");
        else if (groups[kind] && pick[kind] && groups[kind].length) {
          out.push("## " + labels[kind], "");
          let lastSec = "";
          for (const it of groups[kind]) {
            const sec = it.anchor === "head" ? PR.t("論文開頭") : sectionOf(it.anchor);
            if (sec !== lastSec) { out.push("### " + sec, ""); lastSec = sec; }
            const d = it.data;
            const q = exportQuote(it, pick);
            if (it.src === "mine") out.push(...mineAnnotationLines(it, pick));
            else out.push("- " + (d.title ? "**" + d.title + "** " : "") + q + (d.q ? PR.t("（問：{q}）", { q: d.q }) : "") + "\n\n  " + (d.body || "").replace(/\n/g, "\n  "));
          }
          out.push("");
        } else if (kind === "chat" && pick.chat && exportOptions.chat?.length) {
          out.push("## " + PR.t("問 AI 的對話"), "");
          for (const c of exportOptions.chat) out.push(c.role === "user" ? PR.t("**我**：") + c.content : PR.t("**AI**（{model}）：", { model: c.model || "" }) + c.content, "");
        } else if (kind === "mindmap" && pick.mindmap && exportOptions.mindmap) { const fence = String.fromCharCode(96).repeat(3); out.push("## " + PR.t("論文心智圖"), "", fence + "mermaid", exportOptions.mindmap, fence, "");
        } else if (kind === "deep_analysis" && pick.deep_analysis && exportOptions.deepAnalysis) {
          out.push("## " + PR.t("論文深度剖析"), "", exportOptions.deepAnalysis, "");
        }
      }
      return out.join("\n");
    }
    const pn = (S.reader.paper_note || {}).body;
    if (pick.paper && pn) out.push("## " + PR.t("论文笔记"), "", pn, "");
    const want = (it) => it.src === "mine" ? !!pick[it.data.kind === "question" ? "question" : it.data.kind === "highlight" ? "highlight" : "note"] : !!pick.ai;
    const list = (() => { const f = filter; filter = "all"; const r = items().filter(want); filter = f; return r; })();
    if (list.length) out.push("## " + PR.t("批注"), "");
    let lastSec = "";
    for (const it of list) {
      const sec = it.anchor === "head" ? PR.t("论文开头") : sectionOf(it.anchor);
      if (sec !== lastSec) { out.push("### " + sec, ""); lastSec = sec; }
      const d = it.data;
      const q = exportQuote(it, pick);
      if (it.src === "mine") out.push(...mineAnnotationLines(it, pick));
      else out.push("- **AI" + (d.kind === "reply" ? " " + PR.t("回答") : "") + (d.title ? PR.t("：") + d.title : "") + "**" + q + (d.q ? PR.t("（问：{q}）", { q: d.q }) : "") + "\n\n  " + (d.body || "").replace(/\n/g, "\n  "));
    }
    if (pick.chat && chat && chat.length) {
      out.push("", "## " + PR.t("问 AI 的对话"), "");
      for (const c of chat) out.push(c.role === "user" ? PR.t("**我**：") + c.content : PR.t("**AI**（{model}）：", { model: c.model || "" }) + c.content, "");
    }
    return out.join("\n");
  };
})(window.PR);
