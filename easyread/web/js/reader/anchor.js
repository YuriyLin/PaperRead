/* 划线锚定（参考 Hypothesis 的 TextQuote：原话 + 前后文）和选中文字后的浮动条。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const SKIP = ".katex-mathml, .stale-tag, button, .en-title, .num";

  function textNodes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n; (n = w.nextNode());) out.push(n);
    return out;
  }
  const fullText = (root) => textNodes(root).map((t) => t.data).join("");
  PR.fullText = fullText;

  function offsetOf(root, container, offset) {
    let pos = 0;
    for (const t of textNodes(root)) {
      if (t === container) return pos + offset;
      const r = document.createRange();
      r.selectNodeContents(t);
      if (r.comparePoint(container, offset) < 0) return pos;
      pos += t.data.length;
    }
    return pos;
  }

  function stripMdSyntax(q) {
    return String(q || "")
      .replace(/[‖\u200b]/g, "")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
      .replace(/`([^`]+)`/g, "$1");
  }

  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function scoreHit(text, i, len, prefix, suffix) {
    let score = 0;
    const pre = stripMdSyntax(prefix);
    const suf = stripMdSyntax(suffix);
    if (pre && text.slice(Math.max(0, i - pre.length), i).endsWith(pre.slice(-8))) score += 2;
    if (suf && text.slice(i + len, i + len + suf.length).startsWith(suf.slice(0, 8))) score += 2;
    return score;
  }

  function findExactSpan(text, q, prefix, suffix) {
    if (!q) return null;
    let best = -1, bestScore = -1;
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
      const score = scoreHit(text, i, q.length, prefix, suffix);
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best >= 0 ? { i: best, len: q.length } : null;
  }

  function findQuoteSpan(text, q, prefix, suffix) {
    if (!q || !text) return null;
    const direct = findExactSpan(text, q, prefix, suffix);
    if (direct) return direct;
    const stripped = stripMdSyntax(q);
    if (stripped && stripped !== q) {
      const mdHit = findExactSpan(text, stripped, prefix, suffix);
      if (mdHit) return mdHit;
    }
    // 後端 quote 若帶有行內公式 $...$ 或 \(...\)，DOM fullText 中已被渲染為 KaTeX 文字節點；
    // 將公式區段轉為非貪婪萬用區間比對前後文字錨點，即可精準框出整段含公式範圍。
    const mathRe = /(\$\$[\s\S]+?\$\$|\$(?:\\\$|[^$])+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g;
    if (mathRe.test(stripped)) {
      const parts = stripped.split(mathRe);
      let hasAnchor = false;
      const pattern = parts.map((part, idx) => {
        if (idx % 2 === 1) return "[\\s\\S]{1,120}?";
        if (part.trim()) hasAnchor = true;
        return escRe(part).replace(/\s+/g, "\\s*");
      }).join("");
      if (hasAnchor) {
        try {
          const re = new RegExp(pattern, "g");
          let best = null, bestScore = -1, m;
          while ((m = re.exec(text)) !== null) {
            if (!m[0]) { re.lastIndex++; continue; }
            const score = scoreHit(text, m.index, m[0].length, prefix, suffix);
            if (score > bestScore) { best = { i: m.index, len: m[0].length }; bestScore = score; }
          }
          if (best) return best;
        } catch (_) { /* ignore regex errors */ }
      }
    }
    return null;
  }
  PR.findQuoteSpan = findQuoteSpan;

  function findQuote(text, q, prefix, suffix) {
    const hit = findQuoteSpan(text, q, prefix, suffix);
    return hit ? hit.i : -1;
  }

  function katexBounds(root, katexEl) {
    let pos = 0, start = -1, end = -1;
    for (const t of textNodes(root)) {
      const next = pos + t.data.length;
      if (katexEl.contains(t)) {
        if (start < 0) start = pos;
        end = next;
      }
      pos = next;
    }
    return start >= 0 ? [start, end] : null;
  }

  function wrap(root, start, end, attrs) {
    let pos = 0;
    const wrappedKatex = new Set();
    for (const t of textNodes(root)) {
      const a = pos, b = pos + t.data.length;
      pos = b;
      if (b <= start || a >= end) continue;
      // 行內或區塊公式以整個 .katex 為單位標記，避免在 .katex-html 內逐字切碎上下標、分式與根號。
      const katex = t.parentElement && t.parentElement.closest(".katex-display, .katex");
      if (katex && root.contains(katex)) {
        if (wrappedKatex.has(katex)) continue;
        wrappedKatex.add(katex);
        const m = document.createElement("mark");
        for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
        m.classList.add("math-hl");
        katex.parentNode.insertBefore(m, katex);
        m.appendChild(katex);
        continue;
      }
      let node = t;
      const s = Math.max(start, a) - a, e = Math.min(end, b) - a;
      if (e < node.data.length) node.splitText(e);
      if (s > 0) node = node.splitText(s);
      const m = document.createElement("mark");
      for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
    }
  }

  const lost = new Set();
  PR.quoteLost = (id) => lost.has(id);

  function zhFor(item) {
    const host = document.getElementById("b-" + item.anchor);
    if (!host) return null;
    if (item.key) {
      const exact = host.querySelector('.zh[data-key="' + CSS.escape(item.key) + '"]');
      if (exact) return exact;
      if (PR.isTableCellKey && PR.isTableCellKey(item.key)) return null;
    }
    return PR.$$(".zh", host).find((z) => findQuoteSpan(fullText(z), item.quote, item.prefix, item.suffix)) || host.querySelector(".zh");
  }
  /* 标注挂在原文（side: "en"）还是译文上；找不到原话再到另一边找一次：
     只读原文时划在英文上的旧划线没有 side，翻译后英文挪到了 .en 里 */
  function locate(n) {
    if (PR.isTableCellKey && PR.isTableCellKey(n.key)) {
      const cell = PR.tableCell(n.key);
      if (!cell || n.table_source && n.table_source !== cell.source) return null;
    }
    const math = document.getElementById("b-" + n.anchor)?.querySelector(".math-body");
    if (math) {
      const hit = findQuoteSpan(fullText(math), n.quote, n.prefix, n.suffix);
      return hit ? { el: math, i: hit.i, len: hit.len } : null;
    }
    const zh = zhFor(n);
    const first = PR.noteEl(zh, n.side), second = PR.noteEl(zh, n.side === "en" ? "zh" : "en");
    for (const el of PR.isTableCellKey?.(n.key) ? [first] : [first, second]) {
      const hit = el ? findQuoteSpan(fullText(el), n.quote, n.prefix, n.suffix) : null;
      if (hit) return { el, i: hit.i, len: hit.len };
    }
    return null;
  }

  /* 跨段的划线（#46）：quote 是各段原话连起来的全文，parts 记每段的定位；单段的没有 parts */
  const spans = (n) => (n.parts && n.parts.length ? n.parts : [n]);
  PR.noteBlocks = (n) => [...new Set(spans(n).map((p) => p.anchor))];
  PR.markNote = (n) => PR.noteBlocks(n).forEach((a) => PR.applyMarks(a));

  function markFormulaEl(formula, n, id) {
    formula.classList.add("formula-hl", "c-" + (n.color || "yellow"));
    if (n.style === "underline") formula.classList.add("s-ul");
    if (n.kind === "question") formula.classList.add("q");
    formula.dataset.note = id;
  }

  PR.applyMarks = function (onlyBlock) {
    const scope = onlyBlock ? document.getElementById("b-" + onlyBlock) : PR.$("#paper");
    if (!scope) return;
    PR.$$("mark.hl", scope).forEach((m) => m.replaceWith(...m.childNodes));
    PR.$$(".math-body.formula-hl", scope).forEach((m) => {
      m.classList.remove("formula-hl", "c-yellow", "c-green", "c-blue", "c-pink", "s-ul", "q", "active");
      delete m.dataset.note;
    });
    scope.normalize();
    if (!onlyBlock) lost.clear();
    const items = [];
    const seen = new Set(), miss = new Set();
    for (const n of PR.myNotes()) {
      if (n.target === "formula") {
        if (onlyBlock && n.anchor !== onlyBlock) continue;
        seen.add(n.id);
        const formula = document.querySelector("#b-" + CSS.escape(n.anchor) + " .math-body");
        if (!formula) { miss.add(n.id); continue; }
        markFormulaEl(formula, n, n.id);
      } else if (n.quote) {
        const attrs = { class: "hl c-" + (n.color || "yellow") + (n.style === "underline" ? " s-ul" : "") + (n.kind === "question" ? " q" : ""), "data-note": n.id };
        for (const p of spans(n)) items.push({ id: n.id, n, p, attrs });
      }
    }
    for (const e of S.discussion.entries || []) if (e.quote && e.anchor) items.push({ id: e.id, n: e, p: e, attrs: { class: "hl agent", "data-card": e.id } });
    for (const { id, n, p, attrs } of items) {
      if (onlyBlock && p.anchor !== onlyBlock) continue;
      seen.add(id);
      if (p.target === "formula" || p.math) {
        const formula = document.querySelector("#b-" + CSS.escape(p.anchor) + " .math-body");
        if (!formula) { miss.add(id); continue; }
        markFormulaEl(formula, n, id);
        continue;
      }
      const at = locate(p);
      if (!at) { miss.add(id); continue; }
      if (at.el.classList.contains("math-body") && attrs["data-note"]) {
        markFormulaEl(at.el, n, id);
        continue;
      }
      wrap(at.el, at.i, at.i + (at.len || p.quote.length), attrs);
    }
    seen.forEach((id) => (miss.has(id) ? lost.add(id) : lost.delete(id)));
    PR.applyMirrors && PR.applyMirrors(scope);
  };

  /* ---------- 选中文字 -> 浮动条 ---------- */
  const selbar = () => PR.$("#selbar");
  let pendingSel = null;
  const MAX_PARTS = 20;

  function formulaSelection(formula, rect) {
    const blk = formula.closest(".blk-math");
    const block = blk && PR.blockById[blk.dataset.id];
    return blk ? { target: "formula", anchor: blk.dataset.id, key: blk.dataset.id, quote: block && block.tex || fullText(formula), rect: rect && rect.width ? rect : formula.getBoundingClientRect() } : null;
  }

  /* 选区落在某个元素里的那一截；若触及行内 .katex 公式，自动扩展为整条行内公式，避免切碎公式 */
  function partOf(el, range) {
    const math = el.classList.contains("math-body"), zh = math ? null : PR.zhOfEl(el), blk = el.closest(".blk");
    if (!blk || (!math && (!zh || !zh.dataset.key)) || el.querySelector("textarea")) return null;
    if (math) {
      const fSel = formulaSelection(el, range.getBoundingClientRect());
      return fSel ? { anchor: fSel.anchor, key: fSel.key, target: "formula", math: true, quote: fSel.quote } : null;
    }
    const text = fullText(el);
    const rawS = el.contains(range.startContainer) ? offsetOf(el, range.startContainer, range.startOffset) : 0;
    const rawE = el.contains(range.endContainer) ? offsetOf(el, range.endContainer, range.endOffset) : text.length;
    let s = Math.min(rawS, rawE), e = Math.max(rawS, rawE);
    for (const k of PR.$$(".katex", el)) {
      if (!range.intersectsNode(k)) continue;
      const kb = katexBounds(el, k);
      if (!kb) continue;
      if (k.contains(range.startContainer) && k.contains(range.endContainer)) {
        s = kb[0]; e = kb[1];
      } else {
        s = Math.min(s, kb[0]); e = Math.max(e, kb[1]);
      }
    }
    const quote = text.slice(s, e);
    if (!quote.trim()) return null;
    const out = { anchor: blk.dataset.id, key: zh.dataset.key, quote, prefix: text.slice(Math.max(0, s - 32), s), suffix: text.slice(e, e + 32) };
    if (el.dataset.cellId) out.table_source = el.dataset.tableSource;
    if (PR.isEnEl(el)) out.side = "en";
    return out;
  }

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const formula = startEl && startEl.closest("#paper .math-body");
    if (formula && formula.contains(range.endContainer)) return formulaSelection(formula, range.getBoundingClientRect());
    // 译文 .zh、原文 .en 与独立公式 .math-body 都能划
    const el = startEl && startEl.closest("#paper .zh, #paper .en, #paper .math-body");
    if (!el) return null;
    let parts;
    if (el.contains(range.endContainer)) parts = [partOf(el, range)];
    else {  // 跨段（#46）：起点在译文就取选中的每段译文，在原文就取原文，并包含中间的独立公式
      const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
      const textSide = el.classList.contains("math-body") ? (endEl && endEl.closest(".zh, .en")) : el;
      const same = (textSide && PR.isEnEl(textSide) ? "#paper .en, #paper .en-main" : "#paper .zh:not(.en-main)") + ", #paper .math-body";
      parts = PR.$$(same).filter((x) => !x.closest(".table-version")?.hidden && range.intersectsNode(x)).map((x) => partOf(x, range));
    }
    parts = parts.filter(Boolean);
    const limit = parts.every((p) => PR.isTableCellKey && PR.isTableCellKey(p.key)) ? 200 : MAX_PARTS;
    if (!parts.length || parts.length > limit) return null;
    const rect = range.getBoundingClientRect();
    if (parts.length === 1) return Object.assign(parts[0], { rect });
    return Object.assign({}, parts[0], { target: undefined, quote: parts.map((p) => p.quote.trim()).join("\n"), parts, rect });
  }
  PR.hasPendingSelection = () => !!pendingSel && selbar().classList.contains("open");
  PR.readSelection = readSelection;

  // 原生复制包含 KaTeX 的逐字排版层与隐藏 MathML，粘贴到富文本编辑器会变成一字一行且重复两次（#65）
  document.addEventListener("copy", (e) => {
    if (!e.clipboardData || (e.target.closest && e.target.closest("input, textarea, [contenteditable]"))) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!PR.$$("#paper .katex").some((math) => range.intersectsNode(math))) return;
    const selected = readSelection();
    if (!selected) return;
    e.clipboardData.setData("text/plain", selected.quote);
    e.preventDefault();
  });

  function openSelbar(selection) {
    pendingSel = selection;
    const bar = selbar();
    if (!pendingSel) { bar.classList.remove("open"); return; }
    PR.hideBlockbar && PR.hideBlockbar();
    const pen = PR.prefs.pen === "underline" ? "underline" : "marker";
    bar.innerHTML = '<span class="pens"><button data-pen="marker" class="' + (pen === "marker" ? "on" : "") + '" title="' + PR.t("荧光笔：用上次颜色划线") + '">' + PR.icon("marker", "sm") + "</button>" +
      '<button data-pen="underline" class="' + (pen === "underline" ? "on" : "") + '" title="' + PR.t("下划线：用上次颜色划线") + '">' + PR.icon("underline", "sm") + "</button></span>" +
      '<span class="dots pen-' + pen + '">' + PR.HL_COLORS.map(([c, name], i) =>
      '<button data-s="highlight" data-color="' + c + '" class="dot-' + c + '" title="' + (pen === "underline" ? PR.t("{color}色下划线", { color: name }) : PR.t("{color}色荧光笔", { color: name })) + (PR.keysOn ? PR.t("（{k}）", { k: i + 1 }) : "") + '"></button>').join("") + "</span>" +
      '<button data-s="note" title="' + PR.t("写笔记（N）") + '">' + PR.icon("note", "sm") + PR.t("笔记") + "</button>" +
      (PR.isTableCellKey && PR.isTableCellKey(pendingSel.key) ? '<button data-s="page">' + PR.t("核對原始 PDF") + '</button>' : '') +
      (PR.isTableCellKey?.(pendingSel.key) && !pendingSel.parts && !pendingSel.side && PR.feature("edit") ? '<button data-s="edit">' + PR.t("改译文") + '</button>' : '') +
      (pendingSel.target === "formula" ? "" : '<button data-s="question" title="' + PR.t("提问（Q）") + '">' + PR.icon("question", "sm") + PR.t("提问") + "</button>" +
        (PR.canChat && PR.canChat() && PR.feature("chat") ? '<button data-s="chat" title="' + PR.t("把这句引用到问 AI（可以引用多段）") + '">' + PR.icon("sparkle", "sm") + (PR.chatOpen && PR.chatOpen() ? PR.t("引用到对话") : PR.t("问 AI")) + "</button>" : "") +
        (pendingSel.side || pendingSel.parts ? "" : '<button data-s="en" title="' + PR.t("看这段英文") + '">' + PR.icon("en", "sm") + PR.t("原文") + "</button>") +
        '<button data-s="copy" title="' + PR.t("复制") + '">' + PR.icon("copy", "sm") + "</button>");
    bar.classList.add("open");
    const r = pendingSel.rect, w = bar.offsetWidth;
    const x = Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const y = r.top - 48 < 58 ? r.bottom + 8 : r.top - 48;
    bar.style.left = x + "px"; bar.style.top = y + "px";
  }
  function showSelbar() { openSelbar(readSelection()); }
  document.addEventListener("mouseup", (e) => {
    if (e.target.closest && e.target.closest("#selbar, #blockbar")) return;
    const formula = e.target.closest && e.target.closest("#paper .math-body");
    const selection = getSelection();
    if (formula && (!selection || selection.isCollapsed)) return; // 一般點擊交給公式 click handler；拖選才走選取工具列。
    setTimeout(showSelbar, 10);
  });
  document.addEventListener("keyup", (e) => { if (e.shiftKey && e.key.startsWith("Arrow")) showSelbar(); });
  document.addEventListener("selectionchange", PR.debounce(() => { const s = getSelection(); if ((!s || s.isCollapsed) && (!pendingSel || pendingSel.target !== "formula")) selbar().classList.remove("open"); }, 120));

  PR.selectionAction = function (kind, color) {
    if (!pendingSel) return;
    const { anchor, key, quote, prefix, suffix, side, parts, target, table_source } = pendingSel;
    selbar().classList.remove("open");
    getSelection().removeAllRanges();
    pendingSel = null;
    if (kind === "en") { PR.toggleEn(anchor, true); return; }
    if (kind === "page") { PR.openTableCell(key, table_source); return; }
    if (kind === "edit") { const zh = PR.$('#paper .zh[data-key="' + CSS.escape(key) + '"]'); if (zh) PR.editZh(zh); return; }
    if (kind === "copy") { navigator.clipboard.writeText(quote).then(() => PR.toast(PR.t("已复制"))); return; }
    if (kind === "chat") { PR.chatAsk({ anchor, key, quote, side, table_source, parts }); return; }
    const pen = PR.prefs.pen === "underline" ? "underline" : "marker";
    color = color || (PR.prefs.penColors || {})[pen] || "yellow";
    if (target === "formula") {
      const existing = PR.myNotes().find((n) => n.target === "formula" && n.anchor === anchor);
      const note = Object.assign({}, existing || { id: PR.uid("n"), anchor, target, quote, kind: "highlight", body: "", created: PR.nowIso() }, { color });
      if (PR.prefs.pen === "underline") note.style = "underline"; else delete note.style;
      if (kind !== "highlight") note.kind = kind;
      if (kind === "highlight") {
        PR.prefs.penColors = { ...PR.prefs.penColors, [pen]: color };
        PR.applyPrefs();
      }
      PR.saveNote(note);
      PR.applyMarks(anchor);
      if (kind === "highlight") PR.toast(PR.t("已標記公式　點公式可以寫筆記或改顏色"), { label: PR.t("撤销"), fn: () => (PR.undoAnnotation ? PR.undoAnnotation(note.id) : (PR.commit({ op: "note_del", id: note.id }), PR.applyMarks(anchor))) }, 2600);
      else PR.openNoteEditor(note.id);
      return;
    }
    const note = { anchor, key, quote, prefix, suffix, kind, color };
    if (table_source) note.table_source = table_source;
    if (side) note.side = side;
    if (parts) note.parts = parts;
    if (PR.prefs.pen === "underline") note.style = "underline";
    if (kind === "highlight") {
      PR.prefs.penColors = { ...PR.prefs.penColors, [pen]: color };
      PR.applyPrefs();
      Object.assign(note, { id: PR.uid("n"), body: "", created: PR.nowIso() });
      PR.saveNote(note);
      PR.markNote(note);
      PR.toast(PR.t("已划线　点划线可以写笔记或改颜色"), { label: PR.t("撤销"), fn: () => (PR.undoAnnotation ? PR.undoAnnotation(note.id) : (PR.commit({ op: "note_del", id: note.id }), PR.markNote(note))) }, 2600);
    } else PR.startNote(note);
  };
  selbar().addEventListener("mousedown", (e) => e.preventDefault()); // 点按钮时别丢掉选区
  selbar().addEventListener("click", (e) => {
    const p = e.target.closest("[data-pen]");
    if (p) {  // 点笔直接用这支笔上次的颜色划线，色块仍可直接指定颜色。
      PR.prefs.pen = p.dataset.pen;
      return PR.selectionAction("highlight");
    }
    const b = e.target.closest("button[data-s]"); if (b) PR.selectionAction(b.dataset.s, b.dataset.color);
  });

  /* 点划线：写笔记 / 换颜色 / 删掉 */
  document.addEventListener("click", (e) => {
    const m = e.target.closest("mark.hl[data-note], .math-body[data-note]");
    if (!m || getSelection().toString()) return;
    const n = (S.reader.notes || {})[m.dataset.note];
    if (!n) return;
    if (m.classList.contains("math-body")) e.stopImmediatePropagation(); else e.stopPropagation();
    PR.noteMarkClick(m, n);
  }, true);
  document.addEventListener("click", (e) => {
    const formula = e.target.closest("#paper .math-body:not([data-note])");
    if (!formula || getSelection().toString()) return;
    e.stopImmediatePropagation();
    openSelbar(formulaSelection(formula));
  }, true);
  document.addEventListener("keydown", (e) => {
    const formula = e.target.closest && e.target.closest("#paper .math-body");
    if (!formula || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    const note = formula.dataset.note && (S.reader.notes || {})[formula.dataset.note];
    if (note) PR.noteMarkClick(formula, note); else openSelbar(formulaSelection(formula));
  });
  /* 点划线（或另一边的同步标记 m）：划线弹出改色菜单，笔记和问题打开编辑 */
  PR.noteMarkClick = function (m, n) {
    if (n.kind !== "highlight") { PR.openNoteEditor(n.id); return; }
    const ul = n.style === "underline";
    PR.popover(m, '<div class="hd">' + PR.t("我的划线") + '</div><div class="hl-edit"><span class="pens"><button data-hl-style="marker" class="' + (ul ? "" : "on") + '" title="' + PR.t("荧光笔") + '">' + PR.icon("marker", "sm") + '</button><button data-hl-style="underline" class="' + (ul ? "on" : "") + '" title="' + PR.t("下划线") + '">' + PR.icon("underline", "sm") + "</button></span>" +
      '<span class="dots pen-' + (ul ? "underline" : "marker") + '">' + PR.HL_COLORS.map(([c, name]) =>
      '<button data-hl-color="' + c + '" title="' + name + '" class="dot-' + c + ((n.color || "yellow") === c ? " on" : "") + '"></button>').join("") + "</span></div>" +
      '<div style="display:flex;gap:6px"><button class="btn sm line" data-hl="note">' + PR.t("写笔记") + '</button><button class="btn sm line" data-hl="question">' + PR.t("提问") + '</button><button class="btn sm danger" data-hl="del">' + PR.t("删除划线") + '</button></div>', { sticky: true });
    PR.$("#popover").onclick = (ev) => {
      const c = ev.target.closest("[data-hl-color]"), b = ev.target.closest("[data-hl]");
      if (c) {
        const pen = n.style === "underline" ? "underline" : "marker";
        PR.prefs.penColors = { ...PR.prefs.penColors, [pen]: c.dataset.hlColor }; PR.applyPrefs();
        PR.saveNote(Object.assign({}, n, { color: c.dataset.hlColor })); PR.markNote(n); PR.hidePopover(); return;
      }
      const sty = ev.target.closest("[data-hl-style]");
      if (sty) { const x = Object.assign({}, n); if (sty.dataset.hlStyle === "underline") x.style = "underline"; else delete x.style; PR.saveNote(x); PR.markNote(n); PR.hidePopover(); return; }
      if (!b) return;
      PR.hidePopover();
      if (b.dataset.hl === "del") { PR.commit({ op: "note_del", id: n.id }); PR.markNote(n); }
      else { PR.saveNote(Object.assign({}, n, { kind: b.dataset.hl })); PR.openNoteEditor(n.id); }
    };
  };
})(window.PR);
