/* 右侧笔记面板：全部批注按原文顺序排好（可筛选、可就地编辑），以及整篇的“论文笔记”。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  let tab = PR.ls.get("easyread-np-tab", "notes");
  let filter = "all";
  let editing = null;
  let preview = false;
  const panel = () => PR.$("#notespanel");

  PR.notesPanelOpen = () => PR.side === "notes";
  PR.toggleNotesPanel = function (force) {
    const open = force != null ? force : PR.side !== "notes";
    PR.openSide(open ? "notes" : null);
    if (open) PR.renderNotesPanel();
    else editing = null;
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
  const smartItems = () => Object.values(S.reader.ai_annotations || {}).filter((a) => ["pending", "edited"].includes(a.status));
  const smartSections = () => (PR.headings || []).filter((h) => h && h.id).map((h) => ({ id: h.id, label: (h.num ? h.num + " " : "") + PR.plain(PR.textFor(h.id) || h.zh || h.en || "") }));

  function smartColorLegend() {
    const items = [
      ["yellow", PR.t("黃"), PR.t("核心概念、研究動機、主要主張與研究發現")],
      ["green", PR.t("綠"), PR.t("方法、模型架構、技術創新與實作細節")],
      ["blue", PR.t("藍"), PR.t("實驗數據、量化結果、比較證據與觀察")],
      ["pink", PR.t("紅"), PR.t("研究限制、失敗案例、假設條件與待研究問題")],
    ];
    return '<div class="smart-color-legend"><b>' + PR.t("顏色意義") + '</b><div class="smart-color-grid">' + items.map(([color, label, meaning]) =>
      '<div class="smart-color-item"><svg class="smart-color-icon smart-color-' + color + '" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"></circle></svg><span><strong>' + PR.esc(label) + '</strong><small>' + PR.esc(meaning) + '</small></span></div>').join("") + '</div></div>';
  }

  function smartDialog() {
    const dlg = PR.$("#readerDlg");
    const sections = smartSections();
    dlg.querySelector(".dialog").innerHTML = '<h2>' + PR.t("智慧標註") + '</h2>' +
      '<p class="hint">' + PR.t("先產生待確認建議；接受後才會套用到正文，不會覆蓋手動標註。") + '</p>' + smartColorLegend() +
      '<label class="smart-field">' + PR.t("分析模式") + '<select id="smartMode"><option value="auto">' + PR.t("AI 自動標註") + '</option><option value="suggest">' + PR.t("AI 建議標註") + '</option><option value="purpose">' + PR.t("依研究目的標註") + '</option></select></label>' +
      '<label class="smart-field">' + PR.t("分析範圍") + '<select id="smartScope"><option value="all">' + PR.t("全文") + '</option><option value="section">' + PR.t("指定章節") + '</option></select></label>' +
      '<label class="smart-field smart-section-field" hidden>' + PR.t("章節") + '<select id="smartSection">' + sections.map((s) => '<option value="' + PR.esc(s.id) + '">' + PR.esc(s.label) + '</option>').join("") + '</select></label>' +
      '<label class="smart-field">' + PR.t("研究目的（可選）") + '<textarea id="smartPurpose" rows="3" placeholder="' + PR.esc(PR.t("例如：找出可用於 3D segmentation 的方法與限制")) + '"></textarea></label>' +
      '<div class="actions"><button class="btn" data-smart-close>' + PR.t("取消") + '</button><button class="btn primary" data-smart-start>' + PR.t("開始分析") + '</button></div>';
    dlg.classList.add("open");
    const scope = dlg.querySelector("#smartScope");
    const section = dlg.querySelector(".smart-section-field");
    scope.onchange = () => { section.hidden = scope.value !== "section"; };
  }

  function smartCard(a) {
    const label = a.style === "underline" ? PR.t("底線") : PR.t("螢光筆");
    const color = a.color === "pink" ? PR.t("紅") : (PR.HL_COLORS.find(([key]) => key === a.color) || ["", a.color || PR.t("黃")])[1];
    const location = a.locatable ? (a.page ? PR.t("第 {page} 頁", { page: a.page }) : PR.t("已定位")) :
      (a.stale_reason === "translation_changed" ? PR.t("譯文已更新，請重新分析") :
        (a.source_stale ? PR.t("來源已更新，請重新分析") : PR.t("無法定位，請修改原文")));
    return '<article class="smart-card' + (a.locatable ? "" : " smart-unlocatable") + '" data-smart-id="' + PR.esc(a.annotation_id) + '" data-anchor="' + PR.esc(a.anchor || "") + '">' +
      '<div class="smart-card-head"><b>' + PR.t("AI 建議標註") + '</b><span class="smart-meta">' + PR.esc(color) + " · " + PR.esc(label) + " · " + PR.esc(location) + '</span></div>' +
      '<blockquote class="smart-quote">' + PR.md(a.quote || PR.t("沒有可顯示的原文"), { cite: false, xref: false }) + '</blockquote>' +
      (a.note ? '<p class="smart-note"><b>' + PR.t("AI 註記") + '</b> ' + PR.mdBlocks(a.note) + '</p>' : '') +
      (a.reason ? '<p class="smart-reason"><b>' + PR.t("標註原因") + '</b> ' + PR.esc(a.reason) + '</p>' : '') +
      '<div class="smart-actions"><button class="btn sm primary" data-smart-action="accept"' + (a.locatable ? "" : " disabled") + '>' + PR.t("接受") + '</button><button class="btn sm line" data-smart-action="edit">' + PR.t("修改") + '</button><button class="btn sm line danger" data-smart-action="reject">' + PR.t("拒絕") + '</button></div></article>';
  }

  function smartHtml() {
    const list = smartItems();
    const pending = list.filter((a) => a.locatable).length;
    const running = smartJob && ["queued", "running"].includes(smartJob.state);
    let h = '<section class="np-smart"><div class="np-smart-head"><div><b>' + PR.t("AI 待確認標註") + '</b><span class="smart-count">' + list.length + '</span></div><span class="grow"></span>' +
      (running ? '<button class="btn sm line" data-smart-cancel>' + PR.t("取消分析") + '</button>' :
        (pending ? '<button class="btn sm primary" data-smart-action="accept-all">' + PR.t("批次接受") + '</button>' : '') +
        (list.length ? '<button class="btn sm line danger" data-smart-action="reject-all">' + PR.t("批次拒絕") + '</button>' : '')) + '</div>' +
      (running ? '<p class="hint smart-progress"><span class="spin"></span> ' + PR.t("正在分析論文，完成後會顯示待確認項目…") + '</p>' : '') +
      (list.length ? '<div class="np-smart-list">' + list.map(smartCard).join("") + '</div>' : '<p class="hint smart-empty">' + PR.t("尚未產生 AI 標註建議。先按「智慧標註」開始分析。") + '</p>') + '</section>';
    return h;
  }

  async function smartAction(action, id, patch) {
    try {
      await PR.api("/api/p/" + encodeURIComponent(PR.pid) + "/smart-annotation", { method: "POST", body: { action, id, patch } });
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
    if (editId !== undefined) { editing = editId; tab = "notes"; }
    const el = panel();
    if (el.contains(document.activeElement) && document.activeElement.matches("textarea") && editId === undefined) return; // 正在打字，不打断
    const list = items();
    const count = PR.myNotes().length + (S.discussion.entries || []).length;
    let h = '<div class="np-head"><div class="seg"><button data-np="notes" class="' + (tab === "notes" ? "on" : "") + '">' + PR.t("批注 {n}", { n: count }) + '</button><button data-np="paper" class="' + (tab === "paper" ? "on" : "") + '">' + PR.t("论文笔记") + "</button></div>" +
      '<span class="grow"></span><button class="btn sm" data-np-act="md" title="' + PR.t("导出 Markdown") + '">' + PR.t("导出") + '</button><button class="btn icon" data-np-act="close" title="' + PR.t("关闭（M）") + '">×</button></div>';
    if (tab === "paper") {
      const body = (S.reader.paper_note || {}).body || "";
      h += '<div class="np-paper"><div class="np-tools"><span class="hint">' + PR.t("整篇的感悟、总结、待办。自动保存。") + '</span><span class="grow"></span>' + PR.noteHelpButtons() +
        '<button class="btn sm' + (preview ? " on" : "") + '" data-np-act="preview">' + (preview ? PR.t("编辑") : PR.t("预览")) + "</button></div>" +
        (preview ? '<div class="np-preview">' + (body ? PR.mdBlocks(body) : '<p class="hint">' + PR.t("还没有写。") + "</p>") + "</div>"
          : '<textarea id="paperNote" placeholder="' + PR.t("读完这篇，你怎么看？&#10;&#10;可以写：核心论点、我同意/不同意的地方、能用到哪里、还没搞懂的问题……&#10;支持 $公式$、**粗体**，空行分段。") + '">' + PR.esc(body) + "</textarea>") + PR.noteHelpBox() + "</div>";
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
    el.innerHTML = h;
    PR.$$("textarea", el).forEach(PR.autosize);
    const ta = editing && el.querySelector('.card[data-note="' + editing + '"] textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollIntoView({ block: "nearest" }); }
  };

  const savePaperNote = PR.debounce(() => { const ta = PR.$("#paperNote"); if (ta) PR.commit({ op: "paper_note", body: ta.value }); }, 600);
  const saveEditing = PR.debounce(() => {
    const ta = editing && panel().querySelector('.card[data-note="' + editing + '"] textarea');
    const n = editing && (S.reader.notes || {})[editing];
    if (ta && n && ta.value.trim() !== (n.body || "")) PR.saveNote(Object.assign({}, n, { body: ta.value.trim(), kind: n.kind === "highlight" && ta.value.trim() ? "note" : n.kind }));
  }, 600);
  function stopEditing() {
    const ta = editing && panel().querySelector('.card[data-note="' + editing + '"] textarea');
    const n = editing && (S.reader.notes || {})[editing];
    saveEditing.cancel();
    if (ta && n) PR.finishNote(n, ta.value);
    editing = null;
    PR.renderNotesPanel();
    PR.applyMarks();
  }

  panel().addEventListener("input", (e) => {
    PR.autosize(e.target);
    if (e.target.id === "paperNote") {
      savePaperNote();
      const btns = PR.$("#notespanel .nh-btns");  // 笔记从空变成有内容（或反过来）：“起草稿”换成“点评 / 帮我改”
      if (btns && (btns.querySelector('[data-nh="draft"]') ? 1 : 0) !== (e.target.value.trim() ? 0 : 1)) btns.outerHTML = PR.noteHelpButtons();
    }
    else if (e.target.matches(".card textarea")) saveEditing();
  });
  panel().addEventListener("keydown", (e) => {
    if (e.target.matches(".card textarea") && (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey)))) { e.preventDefault(); stopEditing(); }
  });
  panel().addEventListener("focusout", (e) => {
    if (e.target.id === "paperNote") savePaperNote.flush();
    if (!e.target.matches(".card textarea")) return;
    setTimeout(() => { const card = e.target.closest(".card"); if (card && card.isConnected && !card.contains(document.activeElement) && editing === card.dataset.note) stopEditing(); }, 150);
  });
  panel().addEventListener("click", async (e) => {
    const np = e.target.closest("[data-np]");
    if (np) { tab = np.dataset.np; PR.ls.set("easyread-np-tab", tab); return PR.renderNotesPanel(); }
    const nf = e.target.closest("[data-nf]");
    if (nf) { filter = nf.dataset.nf; return PR.renderNotesPanel(); }
    const act = e.target.closest("[data-np-act]");
    if (act) {
      const a = act.dataset.npAct;
      if (a === "close") PR.toggleNotesPanel(false);
      if (a === "md") PR.openExport();
      if (a === "preview") { savePaperNote.flush(); preview = !preview; PR.renderNotesPanel(); }
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
      if (smartButton.dataset.smartAction === "accept-all") return smartAction("accept_all");
      if (smartButton.dataset.smartAction === "reject-all") return smartAction("reject_all");
      const annotation = id && (S.reader.ai_annotations || {})[id];
      if (!annotation) return;
      if (smartButton.dataset.smartAction === "edit") return smartEdit(card, annotation);
      return smartAction(smartButton.dataset.smartAction, id);
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

  async function waitSmartJob(job) {
    smartJob = job;
    PR.renderNotesPanel();
    const timer = setInterval(async () => {
      try {
        const found = (await PR.api("/api/jobs?pid=" + encodeURIComponent(PR.pid))).jobs.find((item) => item.id === job.id);
        if (!found || !["done", "error", "cancelled"].includes(found.state)) return;
        clearInterval(timer);
        smartJob = null;
        await PR.poll();
        PR.renderNotesPanel();
        if (found.state === "done") PR.toast(PR.t("AI 標註分析完成，請逐筆確認結果。"));
        else if (found.state === "error") PR.toast(PR.t("AI 標註分析失敗：{message}", { message: PR.esc(found.message || "") }));
      } catch (_) { /* 下一次輪詢再試 */ }
    }, 1200);
  }

  PR.$("#readerDlg").addEventListener("click", async (e) => {
    if (e.target.closest("[data-smart-close]")) return PR.$("#readerDlg").classList.remove("open");
    const start = e.target.closest("[data-smart-start]");
    if (!start) return;
    start.disabled = true;
    start.innerHTML = '<span class="spin"></span> ' + PR.t("正在送出…");
    try {
      const job = await PR.api("/api/p/" + encodeURIComponent(PR.pid) + "/smart-annotate", { method: "POST", body: {
        scope: PR.$("#smartScope").value, section_id: PR.$("#smartSection").value,
        mode: PR.$("#smartMode").value, purpose: PR.$("#smartPurpose").value,
      } });
      PR.$("#readerDlg").classList.remove("open");
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
    if (PR.isTableCellKey && PR.isTableCellKey(key)) { const c = PR.tableCell(key); return c ? { zh: c.zh, en: c.en, sents: null } : { zh: "", en: "", sents: null }; }
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
    if ([d, ...(d.parts || [])].some((part) => PR.isTableCellKey && PR.isTableCellKey(part.key))) return tableAnnotationLines(d, pick);
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

  function mdValue(text) {
    const math = /(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$])+?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;
    return String(text || "").split(math).map((part, i) => i % 2
      ? part.replace(/\\\|/g, "\\Vert ").replace(/(?<!\\)\|/g, "\\vert ").replace(/</g, "\\lt ").replace(/>/g, "\\gt ").replace(/\r?\n/g, " ")
      : part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/\r?\n/g, "<br>")).join("");
  }
  function tableAnnotationLines(note, pick) {
    const lines = [];
    for (const part of note.parts?.length ? note.parts : [note]) {
      const b = PR.blockById[part.anchor] || {}, cell = PR.tableCell(part.key);
      lines.push("- **" + PR.t("表格 {num}，原文第 {page} 頁", { num: mdValue(b.num || b.id || ""), page: b.page || "?" }) + "**", "  - Cell ID: `" + String(part.key || "").replace(/`/g, "") + "`");
      if (pick.quote) {
        lines.push("  - " + PR.t("選取原話") + " (" + (part.side || "zh") + "): " + mdValue(part.quote));
        if (cell && (!part.table_source || part.table_source === cell.source)) {
          lines.push("  - " + PR.t("英文儲存格") + ": " + mdValue(cell.en), "  - " + PR.t("中文儲存格") + ": " + mdValue(PR.textFor(part.key)));
        } else lines.push("  - " + PR.t("來源已變更或儲存格無法定位，請核對原始 PDF。"));
      }
    }
    if (note.body) lines.push("  - **" + PR.t("我的注記") + ":** " + markdownLines(note.body, "    ").join("\n"));
    return lines;
  }
  function tableEvidence(out, pick, annotations, chat) {
    if (!pick.quote || !PR.tableCell) return out.join("\n");
    const ids = new Set();
    for (const it of annotations) {
      const d = it.data || {}, kind = d.kind === "question" ? "question" : d.kind === "highlight" ? "highlight" : "note";
      if (it.src !== "mine" || !pick[kind]) continue;
      for (const part of d.parts?.length ? d.parts : [d]) if (PR.isTableCellKey(part.key)) ids.add(part.anchor);
    }
    if (pick.chat) for (const message of chat || []) for (const ref of message.refs || []) if (PR.isTableCellKey(ref.key)) ids.add(ref.anchor);
    for (const id of ids) {
      const b = PR.blockById[id];
      if (!b) continue;
      out.push("", "## " + PR.t("表格 {num}，原文第 {page} 頁", { num: mdValue(b.num || id), page: b.page || "?" }), "");
      if (/^[A-Za-z0-9_-]{1,64}$/.test(PR.pid || "") && /^[A-Za-z0-9_-]{1,64}$/.test(id)) out.push("[PaperRead](easyread://open?id=" + encodeURIComponent(PR.pid) + "&block=" + encodeURIComponent(id) + ")", "");
      if (!PR.tableCell(PR.tableCellKey(b, "rows", 0, 0))) { out.push(PR.t("表格結構尚無法可靠呈現，請查看原始 PDF。")); continue; }
      for (const side of ["en", "zh"]) {
        out.push("### " + (side === "en" ? PR.t("英文原文") : PR.t("中文譯文")), "", mdValue(b["caption_" + side]), "");
        const head = b["head_" + side], rows = b["rows_" + side];
        if (!Array.isArray(head) || !Array.isArray(rows)) { out.push(PR.t("表格譯文尚未完整提供，請查看原始 PDF。")); continue; }
        // Markdown has one header row; preserve further header levels as rows
        // rather than inventing spans or dropping labels.
        const display = (matrix, section) => matrix.map((cells, r) => cells.map((value, c) => side === "zh" ? PR.textFor(PR.tableCellKey(b, section, r, c)) : value));
        const shownHead = display(head, "head"), shownRows = display(rows, "rows");
        const first = shownHead.length ? shownHead[0] : rows[0].map(() => "");
        const row = (cells) => "| " + cells.map(mdValue).join(" | ") + " |";
        out.push(row(first), row(first.map(() => "---")), ...shownHead.slice(1).map(row), ...shownRows.map(row), "");
        for (const [i, footnote] of (b["footnotes_" + side] || []).entries()) out.push("- " + mdValue(side === "zh" ? PR.textFor(PR.tableCellKey(b, "note", i)) : footnote));
      }
    }
    return out.join("\n");
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
      const order = Array.isArray(exportOptions.order) ? exportOptions.order : ["paper", "note", "highlight", "question", "ai", "chat", "mindmap"];
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
        } else if (kind === "mindmap" && pick.mindmap && exportOptions.mindmap) { const fence = String.fromCharCode(96).repeat(3); out.push("## " + PR.t("論文心智圖"), "", fence + "mermaid", exportOptions.mindmap, fence, ""); }
      }
      return tableEvidence(out, pick, annotations, exportOptions.chat);
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
    return tableEvidence(out, pick, list, chat);
  };
})(window.PR);
