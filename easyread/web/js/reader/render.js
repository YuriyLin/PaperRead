/* 把 paper.json 的块排成正文。译文优先取“我的修改”，否则取译者稿。
   只读原文（不翻译）整理出来的块没有 zh，正文直接排英文；之后翻译了就地换成中文。 */
(function (PR) {
  "use strict";
  const S = PR.state;

  PR.isTableCellKey = (key) => /#cell:(head|rows|note):\d+(?::\d+)?$/.test(String(key || ""));
  PR.tableCellKey = (b, section, row, col) => b.id + "#cell:" + section + ":" + row + (col == null ? "" : ":" + col);
  PR.tableSource = (b) => PR.hashText(JSON.stringify([b.caption_en || "", b.head_en || [], b.rows_en || [], b.footnotes_en || []]));
  PR.tableCell = function (key) {
    const [id, field] = String(key || "").split("#"), b = PR.blockById[id];
    const m = /^(head|rows|note):(0|[1-9]\d*)(?::(0|[1-9]\d*))?$/.exec((field || "").replace(/^cell:/, ""));
    if (!PR.isTableCellKey(key) || !b || b.type !== "table" || !m) return null;
    const versions = tableVersions(b);
    if (!versions.en) return null;
    const section = m[1], row = +m[2], col = m[3] == null ? null : +m[3];
    if ((section === "note") !== (col == null)) return null;
    const en = section === "note" ? (b.footnotes_en || [])[row] : b[section + "_en"]?.[row]?.[col];
    const zh = section === "note" ? (b.footnotes_zh || [])[row] : b[section + "_zh"]?.[row]?.[col];
    return typeof en === "string" ? { key, block: b, section, row, col, en, zh: versions.zh && typeof zh === "string" ? zh : "", source: PR.tableSource(b) } : null;
  };
  PR.openTableCell = function (key, source) {
    const cell = PR.tableCell(key);
    if (!cell) {
      const b = PR.blockById[String(key).split("#")[0]];
      if (b && b.type === "table" && b.page) PR.openPage(b.page, b.id, false);
      return;
    }
    const b = cell.block, slot = key.split("#cell:")[1];
    const valid = (loc) => loc && Number.isInteger(loc.page) && loc.page === b.page && Array.isArray(loc.box) && loc.box.length === 4 &&
      loc.box.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) && loc.box[0] < loc.box[2] && loc.box[1] < loc.box[3];
    let location = null;
    if ((!source || source === cell.source) && b.table_geometry_source === cell.source && valid(b.table_cell_boxes?.[slot])) location = b.table_cell_boxes[slot];
    if (!location && (!source || source === cell.source) && b.table_geometry_source === cell.source && valid({ page: b.page, box: b.table_source_box })) location = { page: b.page, box: b.table_source_box };
    PR.openPage(b.page, b.id, location || false);
  };

  /* ---------- 译文取值：key 形如 "s1-p1"、"tab1#caption"、"s1-recs#2" ---------- */
  PR.blockById = {};
  function fields(key) {  // [译文, 原文]
    const [id, field] = key.split("#");
    const b = PR.blockById[id];
    if (!b) return ["", ""];
    if (PR.isTableCellKey(key)) { const cell = PR.tableCell(key); return cell ? [cell.zh, cell.en] : ["", ""]; }
    if (field === "caption") return [b.caption_zh || "", b.caption_en || ""];
    if (field === "image") return [b.image_zh || "", b.image_en || ""];
    if (field != null && /^\d+$/.test(field)) { const it = (Array.isArray(b.items) ? b.items : [])[+field] || {}; return [it.zh || "", it.en || ""]; }
    return [b.zh || "", b.en || ""];
  }
  PR.agentText = function (key) { const [zh, en] = fields(key); return zh || en; };
  /* 这处还没有译文、正文排的是英文原文（只读原文） */
  PR.isEnKey = function (key) { const [zh, en] = fields(key); return !zh && !!en && !PR.editOf(key); };
  PR.hasZh = (b) => !!(b.zh || b.caption_zh || b.image_zh ||
    (b.type === "table" && (tableVersions(b).zh || readingData(b))) || (Array.isArray(b.items) && b.items.some((i) => i && i.zh)));
  PR.editOf = function (key) { const e = (S.reader.edits || {})[key]; return e && e.zh != null ? e : null; };
  const sourceChanged = (key, e) => PR.isTableCellKey(key) && e.table_source !== PR.tableCell(key)?.source;
  PR.textFor = function (key) { const e = PR.editOf(key); return e && !sourceChanged(key, e) ? e.zh : PR.agentText(key); };
  PR.isStale = function (key) { const e = PR.editOf(key); return !!(e && (sourceChanged(key, e) || e.base && e.base !== PR.hashText(PR.agentText(key)))); };
  PR.blockKeys = function (b) {
    if (b.type === "list") return (Array.isArray(b.items) ? b.items : []).map((_, i) => b.id + "#" + i);
    if (b.type === "table") return [b.id + "#caption"];
    if (b.type === "figure") return [b.id + "#caption"];
    if (b.type === "math" || b.type === "references" || b.type === "note") return [];
    return [b.id];
  };

  function buildIndex() {
    PR.blockById = {};
    PR.xindex = { eq: {}, tab: {}, fig: {}, sec: {} };
    PR.headings = [];
    PR.refById = {};
    PR.order = {};
    (S.paper.references || []).forEach((r) => (PR.refById[String(r.id)] = r));
    (S.paper.blocks || []).forEach((b, i) => {
      if (!b || typeof b !== "object") return;
      PR.blockById[b.id] = b;
      PR.order[b.id] = i;
      if (b.type === "math" && b.tag) PR.xindex.eq[b.tag] = b.id;
      if (b.type === "table" && b.num) PR.xindex.tab[b.num] = b.id;
      if (b.type === "figure" && b.num) PR.xindex.fig[b.num] = b.id;
      if (b.type === "heading" || b.type === "references") { if (b.num) PR.xindex.sec[b.num] = b.id; PR.headings.push(b); }
    });
  }

  function staleTag(key) { return PR.isStale(key) ? '<button class="stale-tag" data-t="stale" title="' + PR.t("你改过这段之后，译者稿又更新了") + '">' + PR.t("译者稿有更新") + "</button>" : ""; }
  // 段落和列表项有句子对齐时一句一个 span（sentences.js），没有就整段
  const sentMd = (key, side, text) => (PR.sentMd ? PR.sentMd(key, side, text) : PR.md(text));
  function zhDiv(key) {
    const en = PR.isEnKey(key) ? ' lang="en"' : "";
    return '<div class="zh' + (en ? " en-main" : "") + '"' + en + ' data-key="' + PR.esc(key) + '">' + sentMd(key, "zh", PR.textFor(key)) + staleTag(key) + "</div>";
  }
  const enIfZh = (key, text) => (PR.isEnKey(key) ? "" : enDiv(text, key));  // 正文已经是英文了，就不再附一份原文
  function enDiv(text, key) { return text ? '<div class="en" lang="en">' + (key ? sentMd(key, "en", text) : PR.md(text)) + "</div>" : ""; }

  function captionHtml(b) {
    const key = b.id + "#caption";
    const text = PR.textFor(key);
    const m = text.match(/^([^：:]{1,12})[：:]/);
    const body = m ? '<span class="label">' + PR.esc(m[1]) + "</span>" + PR.md(text.slice(m[1].length)) : PR.md(text);
    const en = PR.isEnKey(key) ? ' lang="en"' : "";
    return '<div class="caption"><div class="zh' + (en ? " en-main" : "") + '"' + en + ' data-key="' + key + '">' + body + staleTag(key) + "</div>" + enIfZh(key, b.caption_en) + "</div>";
  }
  function linkify(t) { return PR.esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }

  // Only explicit, rectangular bilingual data is rendered. Legacy head/rows
  // remain untouched: their language cannot be recovered from field names.
  function tableVersions(b) {
    const fallback = { en: null, zh: null };
    if (b.table_schema !== 1 || ("table_status" in b && (typeof b.table_status !== "string" || b.table_status && b.table_status !== "ready")) ||
        ["table_spans", "table_segments"].some((key) => key in b && (!Array.isArray(b[key]) || b[key].length))) return fallback;
    function sideData(side) {
      const head = b["head_" + side], rows = b["rows_" + side], notes = "footnotes_" + side in b ? b["footnotes_" + side] : [];
      if (!Array.isArray(head) || !Array.isArray(rows) || !rows.length || !Array.isArray(notes) || notes.some((n) => typeof n !== "string")) return null;
      const width = Array.isArray(rows[0]) ? rows[0].length : 0;
      if (!width || [...head, ...rows].some((row) => !Array.isArray(row) || row.length !== width || row.some((cell) => typeof cell !== "string"))) return null;
      return { head, rows, notes, width };
    }
    const en = sideData("en");
    if (!en) return fallback;
    let zh = sideData("zh");
    if (zh && (zh.width !== en.width || zh.head.length !== en.head.length || zh.rows.length !== en.rows.length || zh.notes.length !== en.notes.length)) zh = null;
    // A translated caption supplied by the reader still takes precedence.
    if (zh && b.caption_en && !b.caption_zh && !PR.editOf(b.id + "#caption")) zh = null;
    return { en, zh };
  }

  function tablePlaceholder(b, reason) {
    return '<div class="figure-media"><button class="fig-placeholder table-placeholder" data-t="page" aria-label="' + PR.t("表格保留於原文") + '">' +
      '<span>' + PR.t("表格保留於原文") + '</span><small>' + PR.t("表格位於原文第 {n} 頁（點擊查看）", { n: b.page }) + '</small></button>' +
      (reason ? '<p class="table-status">' + PR.esc(reason) + '</p>' : "") + '</div>';
  }

  // Input comes exclusively from the D2.5 reader projection (live or embedded).
  // These guards prevent broken rendering; PDF verification stays on the backend.
  function readingData(b) {
    const r = b.table_reading, values = b.table_reading_zh;
    const segments = r?.source?.segments;
    if (b.table_status !== "fallback" || r?.version !== 1 || !Array.isArray(segments) || !segments.length ||
        !Array.isArray(values) || values.length !== segments.length ||
        values.some((v, i) => !v || typeof v.id !== "string" || v.id !== segments[i]?.id || typeof v.zh !== "string" || !v.zh.trim())) return null;
    return values;
  }

  function readingTable(b) {
    const preview = typeof b.table_reading_preview === "string" && /^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(b.table_reading_preview) ?
      '<button class="table-source-preview" data-t="page" aria-label="' + PR.esc(PR.t("開啟原始 PDF")) + '"><img src="' + PR.esc(b.table_reading_preview) + '" alt="' + PR.esc(PR.t("原始 PDF 表格")) + '"></button>' : tablePlaceholder(b, "");
    const pair = '<div class="table-pair table-reading-pair">' +
      '<div class="table-version" data-table-side="en" lang="en">' + preview + '</div>' +
      '<div class="table-version" data-table-side="zh" lang="zh-Hant">' +
      '<p class="table-status">' + PR.esc(PR.t("閱讀輔助翻譯，非逐格驗證表格")) + '</p>' +
      '<div class="table-reading-text" data-reading-block="' + PR.esc(b.id) + '"></div>' +
      '<button class="btn sm line table-pdf-check" data-t="page">' + PR.esc(PR.t("開啟原始 PDF")) + '</button></div></div>';
    return b.caption_pos === "above" ? captionHtml(b) + pair : pair + captionHtml(b);
  }

  function mountReadingText(scope) {
    PR.$$(".table-reading-text", scope).forEach((node) => {
      const b = PR.blockById[node.dataset.readingBlock], values = b && readingData(b);
      node.replaceChildren();
      if (!values) return;
      values.forEach((value) => {
        const p = document.createElement("p");
        // Never pass model text to Markdown, innerHTML, or annotation keys.
        p.textContent = value.zh;
        node.appendChild(p);
      });
    });
  }

  function tableCaption(b, side) {
    const key = b.id + "#caption", primaryEn = PR.isEnKey(key);
    if (side === "zh" && primaryEn) return "";
    const text = side === "en" ? b.caption_en || "" : PR.textFor(key);
    if (!text) return "";
    const primary = side === "zh" || primaryEn;
    return '<div class="caption"><div class="' + (side === "zh" ? "zh" : primaryEn ? "zh en-main" : "en") + '"' +
      (side === "en" ? ' lang="en"' : "") + (primary ? ' data-key="' + PR.esc(key) + '"' : "") +
      ' data-table-caption="true">' + PR.md(text) + (primary ? staleTag(key) : "") + '</div></div>';
  }

  function tableVersion(b, side, data) {
    let content;
    if (!data) content = tablePlaceholder(b, PR.t("表格譯文尚未完整提供，請查看原始 PDF。"));
    else {
      const sourceOnly = side === "en" && !tableVersions(b).zh, sourceToken = PR.tableSource(b);
      const cellHtml = (text, section, row, col) => {
        const key = PR.tableCellKey(b, section, row, col);
        return '<span class="table-cell-text ' + (side === "zh" ? "zh" : sourceOnly ? "zh en-main" : "en") + '" data-key="' + PR.esc(key) +
          '" data-cell-id="' + PR.esc(key) + '" data-table-source="' + PR.esc(sourceToken) + '">' + PR.md(side === "zh" ? PR.textFor(key) : text) + (side === "zh" ? staleTag(key) : "") + '</span>';
      };
      const rowHtml = (row, tag, index) => '<tr>' + row.map((cell, i) => {
        const align = ({ l: "left", c: "center", r: "right" })[String(b.align || "")[i]] || "left";
        return '<' + tag + (tag === "th" ? ' scope="col"' : "") + ' style="text-align:' + align + '">' + cellHtml(cell, tag === "th" ? "head" : "rows", index, i) + '</' + tag + '>';
      }).join("") + '</tr>';
      content = '<div class="tbl-wrap" tabindex="0" role="region" aria-label="' + PR.esc(PR.t("表格 {num}，原文第 {page} 頁", { num: b.num || "", page: b.page })) + '"><table class="tbl">' + (data.head.length ? '<thead>' + data.head.map((row, i) => rowHtml(row, "th", i)).join("") + '</thead>' : "") +
        '<tbody>' + data.rows.map((row, i) => rowHtml(row, "td", i)).join("") + '</tbody></table></div>' +
        (data.notes.length ? '<div class="table-footnotes">' + data.notes.map((note, i) => '<p>' + cellHtml(note, "note", i) + '</p>').join("") + '</div>' : "");
    }
    const caption = tableCaption(b, side);
    return '<div class="table-version" data-table-side="' + side + '"' + (side === "en" ? ' lang="en"' : "") + '>' +
      (b.caption_pos === "above" ? caption + content : content + caption) + '</div>';
  }

  const R = {
    heading(b) {
      const tag = (b.level || 1) === 1 ? "h2" : "h3";
      const en = PR.isEnKey(b.id);
      return "<" + tag + ' class="zh' + (en ? ' en-main" lang="en"' : '"') + ' data-key="' + b.id + '">' + (b.num ? '<span class="num">' + PR.esc(b.num) + "</span>" : "") +
        "<span>" + PR.md(PR.textFor(b.id)) + "</span>" + staleTag(b.id) +
        (b.en && !en ? '<span class="en-title" lang="en">' + PR.md(b.en, { cite: false, xref: false }) + "</span>" : "") + "</" + tag + ">";
    },
    para: (b) => zhDiv(b.id) + enIfZh(b.id, b.en),
    list(b) {
      const tag = b.ordered ? "ol" : "ul";
      const items = Array.isArray(b.items) ? b.items : [];
      return "<" + tag + ">" + items.map((it, i) => "<li>" + zhDiv(b.id + "#" + i) + enIfZh(b.id + "#" + i, it && it.en) + "</li>").join("") + "</" + tag + ">";
    },
    math: (b) => '<div class="math-row"><div class="math-body" tabindex="0" role="button" aria-label="' + PR.t("公式，點擊可選擇螢光筆或底線") + '">' + PR.tex(b.tex, true) + "</div>" + (b.tag ? '<div class="math-tag">(' + PR.esc(b.tag) + ")</div>" : "") + "</div>",
    table(b) {
      const versions = tableVersions(b);
      if (!versions.en) {
        if (readingData(b)) return readingTable(b);
        const reason = typeof b.table_issue === "string" && b.table_issue ||
          (b.table_schema != null ? PR.t("表格結構尚無法可靠呈現，請查看原始 PDF。") : "");
        const table = tablePlaceholder(b, reason);
        return b.caption_pos === "above" ? captionHtml(b) + table : table + captionHtml(b);
      }
      return '<div class="table-pair">' + tableVersion(b, "zh", versions.zh) + tableVersion(b, "en", versions.en) + '</div>';
    },
    figure(b) {
      const placeholder = '<button class="fig-placeholder" data-t="page" aria-label="' + PR.t("圖表保留於原文") + '">' +
        '<span>' + PR.t("圖表保留於原文") + '</span><small>' + PR.t("圖見原文第 {n} 頁（點擊查看）", { n: b.page }) + '</small></button>';
      return '<div class="figure-media">' + placeholder + '</div>' + captionHtml(b);
    },
    note: (b) => '<div class="inline-note"><div class="lbl">' + PR.t("阅读批注（非原文）") + "</div>" + PR.mdBlocks(b.zh) + "</div>",
    references(b) {
      const refs = (S.paper.references || []).map((r) => '<li id="ref-' + PR.esc(r.id) + '"><span class="n">[' + PR.esc(r.id) + "]</span><span>" + linkify(r.text) + "</span></li>").join("");
      if (!b.zh && b.en) return '<h2 class="zh en-main" lang="en" data-key="' + b.id + '"><span>' + PR.esc(b.en) + '</span></h2><div class="refs"><ol>' + refs + "</ol></div>";
      return '<h2 class="zh" data-key="' + b.id + '"><span>' + PR.esc(b.zh || PR.t("参考文献")) + '</span><span class="en-title" lang="en">' + PR.esc(b.en || "References") + "</span></h2>" +
        '<div class="refs"><p class="note">' + PR.t("条目保留原文，便于检索。") + "</p><ol>" + refs + "</ol></div>";
    },
  };

  function blockClass(b) {
    let c = "blk blk-" + b.type;
    if (b.type === "heading") c += " h" + (b.level || 1) + (b.appendix ? " appendix" : "");
    if (b.type === "references") c += " blk-heading h1";
    if (b.cont) c += " cont";
    if (b.role === "abstract") c += " abstract";
    return c;
  }
  const edited = (b) => PR.blockKeys(b).some((k) => PR.editOf(k));

  function sectionHtml(b, extraClass, pageMark) {
    return '<section class="' + blockClass(b) + (extraClass || "") + '" id="b-' + PR.esc(b.id) + '" data-id="' + PR.esc(b.id) + '">' +
      (pageMark ? '<button class="pgmark" data-t="page" title="' + PR.t("看原文第 {n} 页", { n: b.page }) + '">p.' + b.page + "</button>" : "") +
      R[b.type](b) + (edited(b) ? '<span class="edited-dot" title="' + PR.t("这里有你改过的译文") + '"></span>' : "") + "</section>";
  }

  function blockErrorHtml(b, error) {
    const id = PR.esc(b && b.id ? b.id : "unknown");
    console.error("PaperRead block render failed", b && b.id, error);
    return '<section class="blk blk-error" id="b-' + id + '" data-id="' + id + '">' +
      '<div class="inline-note"><div class="lbl">' + PR.t("这一块没能显示") + '</div><p>' + PR.t("块 {id} 的数据格式有问题，其他内容仍可阅读。", { id }) + '</p></div></section>';
  }

  /* 在线演示的署名和许可（CC BY 要求写明出处），网址做成链接 */
  function creditHtml() {
    const c = S.demo && S.demo.credit;
    if (!c) return "";
    const link = (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u.replace(/^https?:\/\//, "") + "</a>";
    return '<p class="demo-credit">' + PR.esc(c).replace(/https?:\/\/[^\s（）()，。,]+/g, link) + "</p>";
  }

  function headHtml() {
    const m = S.paper.meta || {};
    const tr = S.paper.translation || {};
    const kicker = [m.arxiv, m.venue, m.date].filter(Boolean).map(PR.esc).join("　·　");
    const by = [m.authors, m.affiliation].filter(Boolean).map(PR.esc).join("　·　");
    const pages = (m.pages || []).length, done = (tr.done_pages || []).length, en = (tr.en_pages || []).length;
    const toZh = en && PR.canAsk() && !jobRunning() && (S.job || {}).state !== "confirm" ? '<button class="btn sm line" data-t="translate-en">' + PR.t("翻译成{lang}", { lang: PR.targetName((S.paper.meta || {}).target || PR.target) }) + "</button>" : "";
    const tablesOnly = PR.canAsk() && !jobRunning() && (S.job || {}).state !== "confirm" && pages
      ? '<button class="btn sm line" data-t="translate-tables">' + PR.t("只補譯表格") + '</button>' : '';
    const scope = (en ? "<b>" + PR.t("英文原文") + "</b>　" + (done - en ? PR.t("其中 {n} 页已译，", { n: done - en }) : "") + PR.t("{n} 页没有翻译", { n: en }) + toZh
      : "<b>" + PR.t("译文") + "</b>　" + (pages ? (done >= pages ? PR.t("全文 {n} 页", { n: pages }) : PR.t("已译 {done} / {n} 页", { done, n: pages })) : PR.t("尚未处理"))) +
      (tr.note ? "　" + PR.esc(tr.note) : "") +
      tablesOnly;
    return '<header class="paper-head" id="b-head" data-id="head">' + (kicker ? '<div class="kicker">' + kicker + "</div>" : "") +
      "<h1>" + PR.esc(m.title_zh || m.title_en || PR.t("（正在识别标题）")) + "</h1>" +
      (m.title_zh && m.title_en ? '<p class="title-en" lang="en">' + PR.esc(m.title_en) + "</p>" : "") +
      (by ? '<p class="byline">' + by + "</p>" : "") + '<p class="scope">' + scope + "</p>" + creditHtml() + "</header>";
  }

  /* 还没译的页：放原页图，边译边读 */
  const origFig = (p) => '<figure class="orig-page" id="orig-' + p.n + '"><figcaption>' + PR.t("原文第 {n} 页", { n: p.n }) + '</figcaption><img loading="lazy" src="' + PR.imageUrl(p.img) + '" alt="' + PR.t("原文第 {n} 页", { n: p.n }) + '"></figure>';
  const failedOf = () => ((S.job || {}).state === "partial" && S.job.failed) || {};
  const jobRunning = () => ["queued", "running"].includes((S.job || {}).state);
  const reading = () => !!((S.job || {}).read || ((S.paper.translation || {}).en_pages || []).length);  // 这篇是只读原文

  /* 中间漏掉的页（多半是译失败了）：就地放原页，给重试 */
  function gapHtml(pages) {
    const failed = failedOf();
    const bad = pages.filter((p) => failed[p.n]);
    const running = ["queued", "running"].includes((S.job || {}).state);
    const label = pages.length > 1 ? PR.t("第 {a}–{b} 页", { a: pages[0].n, b: pages[pages.length - 1].n }) : PR.t("第 {n} 页", { n: pages[0].n });
    const head = bad.length ? (reading() ? PR.t("{label}没整理成功：", { label }) : PR.t("{label}没译成功：", { label })) + PR.esc(failed[bad[0].n]) + (PR.canAsk() && !running ? '<button class="btn sm line" data-t="retry-failed">' + PR.t("重试") + "</button>" : "")
      : running ? (reading() ? PR.t("{label}还在排队整理，先放原页。", { label }) : PR.t("{label}还在排队翻译，先放原页。", { label }))
      : reading() ? PR.t("{label}还没整理，先放原页。", { label }) : PR.t("{label}还没有译文，先放原页。", { label });
    return '<div class="pending-pages gap"><div class="pending' + (bad.length ? " bad" : "") + '">' + head + "</div>" + pages.map(origFig).join("") + "</div>";
  }

  function pendingHtml(lastPage) {
    const m = S.paper.meta || {};
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const miss = (m.pages || []).filter((p) => !done.has(p.n) && p.n > lastPage);
    if (!(m.pages || []).length) return '<div class="pending"><span class="spin"></span> ' + PR.t("正在渲染原页、抽取文字…") + "</div>";
    if (!miss.length) return "";
    const job = S.job || {};
    const running = ["queued", "running"].includes(job.state);
    const nFailed = miss.filter((p) => failedOf()[p.n]).length;
    const head = job.state === "confirm" ? PR.t("等待确认期间，仍可阅读原页。") : running ? '<span class="spin"></span> ' + PR.esc(job.message || PR.t("翻译中")) + (job.total ? PR.t("（{done}/{total} 页）", { done: job.done, total: job.total }) : "") + '<span class="hint">' + PR.t("译好的页会自动出现在这里") + (PR.usageShort(job.usage) ? " · " + PR.esc(PR.usageShort(job.usage)) : "") + "</span>"
      : reading() ? PR.t("下面 {n} 页还没整理，先放原页。", { n: miss.length }) + (nFailed ? PR.t("其中 {n} 页上次没整理成功。", { n: nFailed }) : "") +
        (PR.canAsk() && job.state !== "error" ? '<button class="btn sm line" data-t="read-rest">' + PR.t("整理剩下的页") + "</button>" : "")
      : PR.t("下面 {n} 页还没有译文，先放原页。", { n: miss.length }) + (nFailed ? PR.t("其中 {n} 页上次没译成功。", { n: nFailed }) : "") +
        (PR.canAsk() ? '<button class="btn sm line" data-t="translate-rest">' + PR.t("翻译剩下的页") + "</button>" : "");
    const recovery = job.read && job.state === "error" && PR.store.mode === "server"
      ? '<div class="err">' + PR.esc(job.error || job.message || "") + '</div><p class="hint">' + PR.t("整理原文需要可用模型。请检查模型设置后重试；重试使用当前翻译模型，已整理的内容会保留。") +
        '</p><button class="btn sm line" data-t="model-settings">' + PR.t("模型设置") + '</button> <button class="btn sm accent" data-t="read-rest">' + PR.t("重试整理原文") + "</button>"
      : "";
    return '<div class="pending-pages"><div class="pending">' + head + recovery + "</div>" + miss.map(origFig).join("") + "</div>";
  }

  PR.renderPaper = function () {
    buildIndex();
    let html = headHtml() + (PR.store.mode === "server" ? PR.pageCapHtml(S.job) : ""), appendixSeen = false, lastPage = 0;
    const done = new Set((S.paper.translation || {}).done_pages || []);
    const allPages = (S.paper.meta || {}).pages || [];
    for (const raw of S.paper.blocks || []) {
      const b = raw && typeof raw === "object" ? raw : null;
      if (!b || !R[b.type]) continue;
      if (b.page && b.page > lastPage + 1) {
        const gap = allPages.filter((p) => p.n > lastPage && p.n < b.page && !done.has(p.n));
        if (gap.length) html += gapHtml(gap);
      }
      let extra = "";
      if (b.appendix && !appendixSeen) { extra = " appendix-start"; appendixSeen = true; }
      const mark = b.page && b.page > lastPage;
      if (b.page) lastPage = Math.max(lastPage, b.page);
      try {
        html += sectionHtml(b, extra, mark);
      } catch (error) {
        html += blockErrorHtml(b, error);
      }
    }
    PR.$("#paper").innerHTML = html + pendingHtml(lastPage);
    mountReadingText(PR.$("#paper"));
    // 一段译文都没有（只读原文）：顶栏的“译文 / 对照”没意义，藏起来
    document.body.classList.toggle("en-only", (S.paper.blocks || []).length > 0 && !(S.paper.blocks || []).some((b) => b && PR.hasZh(b)));
    // 译文语言决定正文字体（base.css 按 data-target 换字体）；1.3 以前译的论文没记语言，都是中文
    const target = (S.paper.meta || {}).target || ((S.paper.blocks || []).some((b) => b && PR.hasZh(b)) ? "zh" : PR.target);
    document.documentElement.dataset.target = target;
    const paperEl = document.getElementById("paper");
    if (paperEl) paperEl.lang = target === "zh" ? "zh-CN" : target;  // 让浏览器选对日文、韩文字形，西文能断词
    PR.emit("rendered");
  };

  /* 只重排一个块（编辑保存后用），不动别的块 */
  PR.renderBlock = function (id) {
    const b = PR.blockById[id];
    const node = document.getElementById("b-" + id);
    if (!b || !node || !R[b.type]) return;
    const fresh = document.createElement("div");
    try {
      fresh.innerHTML = sectionHtml(b, node.classList.contains("appendix-start") ? " appendix-start" : "", !!node.querySelector(":scope > .pgmark"));
    } catch (error) {
      fresh.innerHTML = blockErrorHtml(b, error);
    }
    const nn = fresh.firstChild;
    ["show-en", "notes-open", "current"].forEach((c) => node.classList.contains(c) && nn.classList.add(c));
    node.replaceWith(nn);
    mountReadingText(nn);
    PR.emit("block-rendered", id);
  };

  /* 版心放不下的长公式、宽表格：先缩小字号，再不行才横向滚动。
     公式原本多宽只和字号、字体有关，量一次记下来；开关侧栏、改窗口大小只是版心变了，不用再把几百个公式复原重量一遍
     （复原再量要整页重排，长论文一两百毫秒，点“原页”“笔记”会明显顿一下）。 */
  // 记的是 { w, over }：over 为真时 w 是放不下时量到的真实宽度；为假时只知道“宽 w 的版心放得下”，版心变窄得重量
  const natural = new WeakMap();
  let typeface = "";
  PR.fitWide = function (scope, remeasure) {  // remeasure：字体刚加载完这类，量过的也不作数
    const paper = PR.$("#paper");
    const cs = getComputedStyle(paper);
    const tf = cs.fontSize + "|" + cs.fontFamily;
    const fresh = remeasure || tf !== typeface;
    typeface = tf;
    const boxes = PR.$$(".math-body, .tbl-wrap", fresh ? paper : scope || paper).filter((box) => box.firstElementChild);
    const avail = boxes.map((box) => box.clientWidth);
    const todo = boxes.filter((box, i) => {
      const n = !fresh && natural.get(box.firstElementChild);
      return !n || !n.w || (!n.over && avail[i] < n.w - 1);  // w 为 0：上次量时藏着（比如对照模式的英文）
    });
    // 要重量的：先全部复原、再一起量、最后一起改，边改边量会让浏览器每个公式都重排一次整页
    todo.forEach((box) => { box.firstElementChild.style.fontSize = ""; });
    todo.forEach((box) => {
      const need = box.firstElementChild.scrollWidth, w = box.clientWidth;
      natural.set(box.firstElementChild, need > w + 1 ? { w: need, over: true } : { w, over: false });
    });
    const floor = window.innerWidth < 760 ? 0.58 : 0.72;
    boxes.forEach((box, i) => {
      const n = natural.get(box.firstElementChild);
      let size = "";
      if (n.over && n.w > avail[i] + 1) {
        const r = Math.max(floor, avail[i] / n.w) * 0.99;
        size = box.classList.contains("tbl-wrap") ? (0.86 * r).toFixed(3) + "em" : (r * 100).toFixed(1) + "%";
      }
      if (box.firstElementChild.style.fontSize !== size) box.firstElementChild.style.fontSize = size;
    });
  };
  PR.on("rendered", () => PR.fitWide());
  PR.on("block-rendered", (id) => PR.fitWide(document.getElementById("b-" + id)));

  /* 保持阅读位置不动地整页重排 */
  PR.rerenderKeepingPlace = function () {
    const anchor = PR.readingBlock && PR.readingBlock();
    const node = anchor && document.getElementById("b-" + anchor);
    const before = node ? node.getBoundingClientRect().top : 0;
    PR.renderPaper();
    const after = anchor && document.getElementById("b-" + anchor);
    if (after) window.scrollBy(0, after.getBoundingClientRect().top - before);
  };
})(window.PR);
