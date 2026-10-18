/* 句子对齐：paper.json 的段落和列表项可以带 sents（[[英文句尾, 译文句尾], …]，按 JS 字符串位置，最后一项是两边总长）。
   有就把原文和译文都切成一句一个 <span class="snt" data-s="i">，两边同号的句子互相对应；
   没有（旧论文、模型没对上）、或者译文被我改过（“我的修改”），就按整段对应。
   标注同步：一边有划线或笔记，另一边对应的句子（没有句子对应时是整段）标一道虚线或段边色条，点它和点划线一样。 */
(function (PR) {
  "use strict";
  const S = PR.state;

  function objOf(key) {
    const [id, field] = String(key).split("#");
    const b = PR.blockById[id];
    if (!b) return null;
    if (b.type === "para" && field == null) return b;
    if (b.type === "list" && /^\d+$/.test(field || "")) return (Array.isArray(b.items) ? b.items : [])[+field] || null;
    return null;
  }

  /* 这处的句子对齐还对得上文字就返回 sents，否则 null */
  PR.alignOf = function (key) {
    const o = objOf(key);
    const s = o && o.sents;
    if (!Array.isArray(s) || s.length < 2) return null;
    const en = o.en || "", zh = o.zh || "", last = s[s.length - 1];
    if (!Array.isArray(last) || last[0] !== en.length || last[1] !== zh.length) return null;
    for (let i = 0; i < s.length; i++) {
      const prev = i ? s[i - 1] : [0, 0];
      if (!Array.isArray(s[i]) || !(s[i][0] > prev[0]) || !(s[i][1] > prev[1])) return null;
    }
    return s;
  };

  const balanced = (t) => (t.split("**").length % 2 === 1) && ((t.match(/(?<!\\)\$/g) || []).length % 2 === 0);

  /* 正文 HTML：对得上就一句一个 span，否则和原来一样整段 PR.md。side：en 原文 / zh 译文 */
  PR.sentMd = function (key, side, text) {
    const s = PR.alignOf(key), o = objOf(key);
    if (!s || !o || (side === "zh" && PR.editOf(key)) || text !== (side === "en" ? o.en : o.zh)) return PR.md(text);
    const col = side === "en" ? 0 : 1;
    const parts = [];
    let prev = 0;
    for (const row of s) { parts.push(text.slice(prev, row[col])); prev = row[col]; }
    if (!parts.every(balanced)) return PR.md(text);  // 句界切在 **粗体** 或公式中间：不切，整段显示
    return parts.map((p, i) => {
      const lead = p.match(/^\s*/)[0];
      return lead + '<span class="snt" data-s="' + i + '">' + PR.md(p.slice(lead.length)) + "</span>";
    }).join("");
  };

  /* ---------- 原文 / 译文两个元素互相找 ---------- */
  const isEnEl = (el) => el.classList.contains("en") || el.classList.contains("en-main");
  PR.isEnEl = isEnEl;
  function cellPartner(el, side) {
    const pair = el.closest(".table-pair");
    return pair ? Array.from(pair.querySelectorAll(".table-cell-text[data-key]")).find((node) => node.dataset.key === el.dataset.key &&
      (side === "zh" ? node.classList.contains("zh") : node.classList.contains("en"))) || null : null;
  }
  /* 原文元素对应的 .zh[data-key]（同一层的兄弟；只读原文没译的块，.zh 自己就是原文） */
  PR.zhOfEl = function (el) {
    if (el.classList.contains("zh")) return el;
    if (el.dataset.cellId) return cellPartner(el, "zh");
    if (el.dataset.tableCaption) return el.closest(".table-pair")?.querySelector('.zh[data-key]') || null;
    return Array.from(el.parentElement ? el.parentElement.children : []).find((n) => n.classList.contains("zh") && n.dataset.key) || null;
  };
  PR.enOfZh = function (zh) {
    if (!zh || zh.classList.contains("en-main")) return null;
    if (zh.dataset.cellId) return cellPartner(zh, "en");
    if (zh.dataset.tableCaption) return zh.closest(".table-pair")?.querySelector('.en[data-table-caption]') || null;
    return Array.from(zh.parentElement ? zh.parentElement.children : []).find((n) => n.classList.contains("en")) || null;
  };
  /* 一条标注挂在哪个元素上：side 为 en 找原文，其余（旧标注没有 side）找译文 */
  PR.noteEl = function (zh, side) {
    if (!zh) return null;
    if (side !== "en" || zh.classList.contains("en-main")) return zh;
    return PR.enOfZh(zh);
  };
  const partner = (el) => (isEnEl(el) && !el.classList.contains("en-main") ? PR.zhOfEl(el) : el.classList.contains("zh") && !el.classList.contains("en-main") ? PR.enOfZh(el) : null);

  /* ---------- 标注同步到另一边 ---------- */
  const MIR = ["mir", "mir-para", "c-yellow", "c-green", "c-blue", "c-pink", "mir-q"];
  PR.applyMirrors = function (scope) {
    scope = scope || PR.$("#paper");
    if (!scope) return;
    PR.$$("[data-mirror]", scope).forEach((el) => { el.classList.remove(...MIR); el.removeAttribute("data-mirror"); el.removeAttribute("title"); });
    const byNote = {};  // 一次取出所有划线按笔记分组，不必每条笔记查一遍全文
    PR.$$("mark.hl[data-note]", scope).forEach((m) => (byNote[m.dataset.note] = byNote[m.dataset.note] || []).push(m));
    for (const n of PR.myNotes()) {
      const marks = n.quote && byNote[n.id];
      if (!marks) continue;
      for (const src of new Set(marks.map((m) => m.closest(".zh, .en")).filter(Boolean))) {
      const other = src && partner(src);
      if (!other) continue;
      const idx = new Set(marks.filter((m) => src.contains(m)).map((m) => m.closest(".snt")).filter(Boolean).map((sp) => sp.dataset.s));
      const spans = idx.size ? PR.$$(":scope .snt", other).filter((sp) => idx.has(sp.dataset.s)) : [];
      const targets = spans.length ? spans : [other];
      const cls = [spans.length ? "mir" : "mir-para", "c-" + (n.color || "yellow")].concat(n.kind === "question" ? ["mir-q"] : []);
      const tip = isEnEl(src) ? PR.t("对应原文里的标注") : PR.t("对应译文里的标注");
      // 同一处有几条标注时留第一条（按时间排在前面的），颜色不会叠在一起
      targets.filter((t) => !t.dataset.mirror).forEach((t) => { t.classList.add(...cls); t.dataset.mirror = n.id; t.title = tip; });
      }
    }
  };

  /* 点同步标记：和点划线一样（划线弹改色菜单，笔记和问题打开编辑）。
     整段的同步标记只有段边那道色条能点，点段落其余地方照常（出操作条、双击改译文）；正在改这段时不拦 */
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("[data-mirror]");
    if (!el || e.target.closest("mark.hl, a, button, textarea") || el.querySelector("textarea") || getSelection().toString()) return;
    if (el.classList.contains("mir-para")) {
      const r = el.getBoundingClientRect();
      if (e.clientX > r.left + 14) return;
    }
    const n = (S.reader.notes || {})[el.dataset.mirror];
    if (!n || n.deleted) return;
    e.stopPropagation();
    PR.noteMarkClick(el, n);
  }, true);

  /* 双语对照时指着一句，另一边对应的那句也淡淡标出来 */
  let lit = [];
  document.addEventListener("mouseover", (e) => {
    const sp = e.target.closest && e.target.closest("#paper .snt");
    const host = sp && sp.closest(".zh, .en");
    const other = host && partner(host);
    const pair = other && other.offsetParent ? PR.$$(":scope .snt", other).find((x) => x.dataset.s === sp.dataset.s) : null;
    const next = pair ? [sp, pair] : [];
    if (next[0] === lit[0]) return;
    lit.forEach((x) => x.classList.remove("pair"));
    lit = next;
    lit.forEach((x) => x.classList.add("pair"));
  });
})(window.PR);
