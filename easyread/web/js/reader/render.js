/* 把 paper.json 的块排成正文。译文优先取“我的修改”，否则取译者稿。
   只读原文（不翻译）整理出来的块没有 zh，正文直接排英文；之后翻译了就地换成中文。 */
(function (PR) {
  "use strict";
  const S = PR.state;

  /* ---------- 译文取值：key 形如 "s1-p1"、"tab1#caption"、"s1-recs#2" ---------- */
  PR.blockById = {};
  function fields(key) {  // [译文, 原文]
    const [id, field] = key.split("#");
    const b = PR.blockById[id];
    if (!b) return ["", ""];
    if (field === "caption") return [b.caption_zh || "", b.caption_en || ""];
    if (field === "image") return [b.image_zh || "", b.image_en || ""];
    if (field != null && /^\d+$/.test(field)) { const it = (Array.isArray(b.items) ? b.items : [])[+field] || {}; return [it.zh || "", it.en || ""]; }
    return [b.zh || "", b.en || ""];
  }
  PR.agentText = function (key) { const [zh, en] = fields(key); return zh || en; };
  /* 这处还没有译文、正文排的是英文原文（只读原文） */
  PR.isEnKey = function (key) { const [zh, en] = fields(key); return !zh && !!en && !PR.editOf(key); };
  PR.hasZh = (b) => !!(b.zh || b.caption_zh || b.image_zh || (Array.isArray(b.items) && b.items.some((i) => i && i.zh)));
  PR.editOf = function (key) { const e = (S.reader.edits || {})[key]; return e && e.zh != null ? e : null; };
  PR.textFor = function (key) { const e = PR.editOf(key); return e ? e.zh : PR.agentText(key); };
  PR.isStale = function (key) { const e = PR.editOf(key); return !!(e && e.base && e.base !== PR.hashText(PR.agentText(key))); };
  PR.blockKeys = function (b) {
    if (b.type === "list") return (Array.isArray(b.items) ? b.items : []).map((_, i) => b.id + "#" + i);
    if (b.type === "table") return [b.id + "#caption"];
    if (b.type === "figure") return [b.id + "#caption"];
    if (b.type === "math" || b.type === "references" || b.type === "note") return [];
    return [b.id];
  };

  function buildIndex() {
    if (PR.buildFootnoteIndex) PR.buildFootnoteIndex(S.paper.blocks);
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
  const sentMd = (key, side, text) => (PR.sentMd ? PR.sentMd(key, side, text) : PR.md(text, PR.footnoteOptions ? PR.footnoteOptions(key) : undefined));
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
    const opts = PR.footnoteOptions ? PR.footnoteOptions(b.id) : undefined;
    const body = m ? '<span class="label">' + PR.esc(m[1]) + "</span>" + PR.md(text.slice(m[1].length), opts) : PR.md(text, opts);
    const en = PR.isEnKey(key) ? ' lang="en"' : "";
    return '<div class="caption"><div class="zh' + (en ? " en-main" : "") + '"' + en + ' data-key="' + key + '">' + body + staleTag(key) + "</div>" + enIfZh(key, b.caption_en) + "</div>";
  }
  function zoomBtnHtml(b) {
    if (!b || !b.page) return "";
    const label = PR.t("放大檢視原文第 {n} 頁", { n: b.page });
    const icon = PR.icon ? PR.icon("search", "sm") : '<svg class="i sm" viewBox="0 0 20 20" aria-hidden="true"><path d="M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM13.5 13.5L17 17"/></svg>';
    const blockAttr = b.id ? ' data-zoom-block="' + PR.esc(b.id) + '"' : "";
    return '<button type="button" class="fig-zoom-btn" data-zoom-page="' + b.page + '"' + blockAttr + ' title="' + PR.esc(label) + '" aria-label="' + PR.esc(label) + '">' + icon + "</button>";
  }
  function linkify(t) { return PR.esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }

  const R = {
    heading(b) {
      const tag = (b.level || 1) === 1 ? "h2" : "h3";
      const en = PR.isEnKey(b.id);
      return "<" + tag + ' class="zh' + (en ? ' en-main" lang="en"' : '"') + ' data-key="' + b.id + '">' + (b.num ? '<span class="num">' + PR.esc(b.num) + "</span>" : "") +
        "<span>" + PR.md(PR.textFor(b.id), PR.footnoteOptions ? PR.footnoteOptions(b.id) : undefined) + "</span>" + staleTag(b.id) +
        (b.en && !en ? '<span class="en-title" lang="en">' + PR.md(b.en, { cite: false, xref: false }) + "</span>" : "") + "</" + tag + ">";
    },
    para: (b) => (b.role === "footnote" ? '<span class="footnote-label"><sup>' + PR.esc(b.num || "") + "</sup></span>" : "") + zhDiv(b.id) + enIfZh(b.id, b.en),
    list(b) {
      const tag = b.ordered ? "ol" : "ul";
      const items = Array.isArray(b.items) ? b.items : [];
      return "<" + tag + ">" + items.map((it, i) => "<li>" + zhDiv(b.id + "#" + i) + enIfZh(b.id + "#" + i, it && it.en) + "</li>").join("") + "</" + tag + ">";
    },
    math: (b) => '<div class="math-row"><div class="math-body" tabindex="0" role="button" aria-label="' + PR.t("公式，點擊可選擇螢光筆或底線") + '">' + PR.tex(b.tex, true) + "</div>" + (b.tag ? '<div class="math-tag">(' + PR.esc(b.tag) + ")</div>" : "") + "</div>",
    table(b) {
      const placeholder = '<button class="fig-placeholder table-placeholder" data-t="page" aria-label="' + PR.t("表格保留於原文") + '">' +
        '<span>' + PR.t("表格保留於原文") + '</span><small>' + PR.t("表格位於原文第 {n} 頁（點擊查看）", { n: b.page }) + '</small></button>';
      const table = '<div class="figure-media">' + placeholder + zoomBtnHtml(b) + '</div>';
      return b.caption_pos === "above" ? captionHtml(b) + table : table + captionHtml(b);
    },
    figure(b) {
      const placeholder = '<button class="fig-placeholder" data-t="page" aria-label="' + PR.t("圖表保留於原文") + '">' +
        '<span>' + PR.t("圖表保留於原文") + '</span><small>' + PR.t("圖見原文第 {n} 頁（點擊查看）", { n: b.page }) + '</small></button>';
      return '<div class="figure-media">' + placeholder + zoomBtnHtml(b) + '</div>' + captionHtml(b);
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
    if (b.role === "footnote") c += " footnote";
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
    const scope = (en ? "<b>" + PR.t("英文原文") + "</b>　" + (done - en ? PR.t("其中 {n} 页已译，", { n: done - en }) : "") + PR.t("{n} 页没有翻译", { n: en }) + toZh
      : "<b>" + PR.t("译文") + "</b>　" + (pages ? (done >= pages ? PR.t("全文 {n} 页", { n: pages }) : PR.t("已译 {done} / {n} 页", { done, n: pages })) : PR.t("尚未处理"))) +
      (tr.note ? "　" + PR.esc(tr.note) : "") +
      "";
    const editBtn = '<button class="title-edit-btn" data-t="edit-title" title="' + PR.t("编辑翻译标题（也可直接双击标题）") + '" aria-label="' + PR.t("编辑翻译标题") + '">' + PR.icon("edit", "sm") + "</button>";
    return '<header class="paper-head" id="b-head" data-id="head">' + (kicker ? '<div class="kicker">' + kicker + "</div>" : "") +
      '<h1 data-title-key="title_zh" title="' + PR.t("双击可编辑翻译标题") + '"><span class="title-text">' + (PR.titleHtml ? PR.titleHtml(m.title_zh || m.title_en || PR.t("（正在识别标题）")) : PR.esc(m.title_zh || m.title_en || PR.t("（正在识别标题）"))) + "</span>" + editBtn + "</h1>" +
      (m.title_zh && m.title_en && m.title_zh !== m.title_en ? '<p class="title-en" lang="' + (m.target === "en" ? "" : "en") + '" data-title-key="title_en">' + (PR.titleHtml ? PR.titleHtml(m.title_en) : PR.esc(m.title_en)) + "</p>" : "") +
      (by ? '<p class="byline">' + by + "</p>" : "") + '<p class="scope">' + scope + "</p>" + creditHtml() + "</header>";
  }

  PR.renderPaperHead = function () {
    const head = PR.$("#b-head");
    if (!head) return;
    head.outerHTML = headHtml();
    PR.applyReadingLanguage && PR.applyReadingLanguage();
  };

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
    let ctxTip = "";
    if (bad.length) {
      const err = failed[bad[0].n] || "";
      if (/exceeds (?:the )?available context|context length|context size|context_length/i.test(err)) {
        ctxTip = '<div class="pending-tip">' + PR.t("提示：请求超出模型上下文窗口。建议在 config.json 将 batch_pages 改为 1（改为每次只译 1 页），或在本地模型中调大 context size / num_ctx。") + '</div>';
      }
    }
    const head = bad.length ? (reading() ? PR.t("{label}没整理成功：", { label }) : PR.t("{label}没译成功：", { label })) + PR.esc(failed[bad[0].n]) + (PR.canAsk() && !running ? '<button class="btn sm line" data-t="retry-failed">' + PR.t("重试") + "</button>" : "") + ctxTip
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
