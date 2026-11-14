/* 行内标记：$TeX$ / \(TeX\)、**粗体**、*斜体*、`代码`、[n] 引用，以及“公式 (1) / 表 2 / 第 2.2 节 / 附录 A”这类交叉引用。
   译文、讨论、笔记都用同一套，用户编辑时看到的就是这套原始标记。 */
(function (PR) {
  "use strict";
  // 先识别代码和完整公式，避免分段、Markdown 和表格的 | 拆坏 TeX。
  // For numeric openers, a dollar introducing another price or following prose is not a close.
  const TOKENS = new RegExp([
    /(?<!\\)(`+)([\s\S]*?)\1/.source,  // i18n-ok
    /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/.source,
    /(?<![\\$])\$(?!\$)((?![0-9])(?:\\\$|[^$])+?|[0-9](?:\\\$|[^$])*?(?<![\s，。；、：（(\u3400-\u9fff])(?=\$(?![0-9])))(?<!\\)\$(?!\$)/.source,
    /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/.source,
    /(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/.source,
        // 链接文字不以 [ 开头：[[A](#cite:…), [B](#cite:…)] 外层的方括号是正文，不是第一个链接的一部分。
    /(?<!\\)\[((?:\\.|[^\[\]\\\n])+)\]\(((?:[^\s()<>]|\([^\s()<>]*\))+)\)/.source,
  ].join("|"), "g");
  const mathCache = new Map();

  function tokens(text, blocks) {
    let prefix = "\uE000";
    while (text.includes(prefix)) prefix += "\uE000";
    const values = [];
    const masked = text.replace(TOKENS, (raw, ticks, code, dollarBlock, dollarInline, bracketBlock, parenInline, linkLabel, linkUrl) => {
      if (linkLabel != null) {
        values.push({ raw, text: linkLabel.replace(/\\([\[\]\\])/g, "$1"), link: linkUrl });
        return prefix + (values.length - 1) + "I\uE001";
      }
      const display = ticks ? ticks.length >= 3 && code.includes("\n") : dollarBlock != null || bracketBlock != null;
      const body = ticks ? (display ? code.replace(/^[\w+-]*\r?\n/, "") : code) : dollarBlock ?? dollarInline ?? bracketBlock ?? parenInline;
      values.push({ raw, text: body, code: !!ticks, display });
      return prefix + (values.length - 1) + (blocks && display ? "B" : "I") + "\uE001";
    });
    return { text: masked, values, inline: new RegExp(prefix + "(\\d+)I\uE001", "g"), blocks: new RegExp(prefix + "(\\d+)B\uE001", "g") };
  }

  const INTERNAL = /^#(fig|tab|eq|sec|alg|lst):(.+)$/;
  function tokenHtml(t, block, opts) {
    if (t.link && t.link.startsWith("#")) {
      opts = opts || {};
      if (t.link.startsWith("#cite:")) {
        const ref = opts.cite !== false && PR.citeTarget(t.link.slice(6));
        return ref ? '<a class="cite" data-ref="' + PR.esc(ref) + '">' + PR.esc(t.text) + "</a>" : PR.esc(t.text);
      }
      const m = t.link.match(INTERNAL);
      const target = m && opts.xref !== false && PR.xindex && PR.xindex[m[1]] && PR.xindex[m[1]][m[2]];
      return target ? '<a class="xref" data-kind="' + m[1] + '" data-key="' + PR.esc(m[2]) + '">' + PR.esc(t.text) + "</a>" : PR.esc(t.text);
    }
    if (t.link) {
      if (!/^(https?:\/\/|mailto:)/i.test(t.link) || /[\x00-\x20\x7f]/.test(t.link)) return PR.esc(t.raw);
      try {
        const url = new URL(t.link);
        if (url.protocol !== "mailto:" && !url.hostname) return PR.esc(t.raw);
        return '<a class="external-link" href="' + PR.esc(url.href) + '" target="_blank" rel="noopener noreferrer">' + PR.esc(t.text) + '</a>';
      } catch (e) { return PR.esc(t.raw); }
    }
    if (t.code) return (t.display ? "<pre><code>" : "<code>") + PR.esc(t.text) + (t.display ? "</code></pre>" : "</code>");
    const html = PR.tex(t.display ? t.text.trim() : t.text, t.display);
    return block ? '<div class="eq">' + html + "</div>" : html;
  }

  function restore(s, saved, raw, opts) {
    return s.replace(saved.inline, (m, i) => raw ? saved.values[i].raw : tokenHtml(saved.values[i], false, opts));
  }

  PR.unlink = (text) => String(text || "").replace(/(?<!\\)\[((?:\\.|[^\]\\\n])+)\]\(#[^)\s]*\)/g, (m, words) => words.replace(/\\([\[\]\\])/g, "$1"));

  PR.tex = function (tex, display) {
    const key = (display ? "D" : "I") + tex;
    if (mathCache.has(key)) return mathCache.get(key);
    let html;
    try {
      html = katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: "ignore", trust: false });
    } catch (e) {
      html = '<code title="' + PR.t("公式渲染失败") + '">' + PR.esc(tex) + "</code>";
    }
    mathCache.set(key, html);
    return html;
  };

  /* 摘要或引文高亮關鍵字，同時安全渲染 LaTeX 數學公式與代碼 */
  PR.highlightSnippet = function (text, terms, markClass) {
    if (text == null || text === "") return "";
    const cls = markClass || "rw-kw-mark";
    const saved = tokens(String(text), false);
    const list = Array.isArray(terms) ? terms : [terms];
    const valid = list
      .flatMap((t) => (Array.isArray(t) ? t : [t]))
      .map((t) => (t == null ? "" : String(t)).trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m));

    let body;
    if (!valid.length) {
      body = PR.esc(saved.text);
    } else {
      const regex = new RegExp("(" + valid.join("|") + ")", "gi");
      const parts = saved.text.split(regex);
      body = parts.map((p, idx) => idx % 2 === 1
        ? '<mark class="' + PR.esc(cls) + '">' + PR.esc(p) + "</mark>"
        : PR.esc(p)
      ).join("");
    }
    return restore(body, saved, false);
  };

  // Titles allow math, but preserve literal Markdown punctuation and links.
  PR.titleHtml = function (text) {
    const saved = tokens(String(text == null ? "" : text), false);
    return PR.esc(saved.text)
      .replace(/&lt;(\/?(?:sup|sub))&gt;/gi, (_, tag) => "<" + tag.toLowerCase() + ">")
      .replace(saved.inline, (match, index) => {
        const token = saved.values[index];
        return token.code || token.link ? PR.esc(token.raw) : PR.tex(token.text, false);
      });
  };
  PR.titleText = function (text) {
    return String(text == null ? "" : text)
      .replace(/\$\$([\s\S]+?)\$\$|\$([^$]+)\$|\\\\\[([\s\S]+?)\\\\\]|\\\\\(([^)]*?)\\\\\)/g, (m, block, inline, bracket, paren) => block ?? inline ?? bracket ?? paren ?? m)
      .replace(/\\[a-zA-Z]+(?:\{([^}]*)\})?/g, (m, inner) => inner || "")
      .replace(/<\/?sup>/gi, "")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const superscriptNumber = /^[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}/;
  function noteNumber(b) {
    if (b.type !== "para") return "";
    if (b.role === "footnote" && /^\d{1,3}$/.test(String(b.num))) return String(b.num);
    // Older papers used ids such as fn3-1 (the suffix is a sequence, not the note number).
    if (!/^fn(?:\d|[-_])/.test(b.id) && b.role !== "footnote") return "";
    const text = String(b.en || b.zh || "").trimStart();
    return text.match(superscriptNumber)?.[0].normalize("NFKC") ||
      text.match(/^\$\^\{?(\d{1,3})\}?\$/)?.[1] || text.match(/^(\d{1,3})(?!\d)/)?.[1] || "";
  }
  PR.buildFootnoteIndex = function (blocks) {
    const index = { pages: new Map(), all: new Map() };
    const add = (map, key, id) => map.set(key, map.has(key) ? null : id);
    for (const b of blocks || []) {
      const n = noteNumber(b);
      if (!n) continue;
      add(index.pages, b.page + ":" + n, b.id);
      add(index.all, n, b.id);
    }
    PR.footnoteIndex = index;
  };
  PR.footnoteOptions = function (key) {
    const b = (PR.blockById || {})[String(key).split("#")[0]];
    if (!b) return {};
    return { footnotePage: b.page };
  };

  const citeParts = (key) => String(key || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/-+/).map((p) => p.replace(/[^a-z0-9+]/g, "")).filter(Boolean);
  const looseKey = (parts) => (parts.length > 1 && /^\d{4}[a-z]?$/.test(parts[parts.length - 1]) ? parts[0] + "-" + parts[parts.length - 1] : "");
  PR.buildCiteIndex = function (references) {
    const exact = new Map(), loose = new Map();
    for (const r of references || []) {
      const id = String(r.id), parts = citeParts(id), short = looseKey(parts);
      exact.set(parts.join("-"), id);
      if (short) loose.set(short, loose.has(short) ? null : id);
    }
    PR.citeIndex = { exact, loose };
  };
  PR.citeTarget = function (key) {
    const ix = PR.citeIndex, parts = citeParts(key);
    return ix ? ix.exact.get(parts.join("-")) || ix.loose.get(looseKey(parts)) || "" : "";
  };
  PR.refLabel = (id) => (/^\d+[a-z]?$/.test(id) || !/\d{4}[a-z]?$|^r[0-9a-f]{8}$/.test(id) ? "[" + id + "]" : "");

  function citeLinks(s) {
    return s.replace(/\[(\d+(?:\s*[,，–-]\s*\d+)*)\]/g, (m, inner) => {
      const parts = inner.split(/(\s*[,，–-]\s*)/);
      const linked = parts.map((p) => (/^\d+$/.test(p) && PR.refById && PR.refById[p])
        ? '<a class="cite" data-ref="' + p + '">' + p + "</a>" : p).join("");
      return "[" + linked + "]";
    });
  }

  /* AI 回答里偶尔会带出段落编号 [p4-5]、[eq7]，换成读者看得懂的“式 7”“第 4 页” */
  function blockLabel(s) {
    return s.replace(/\[([a-z]+\d*(?:-[\w-]+)?)\]/g, (m, id) => {
      const b = PR.blockById && PR.blockById[id];
      if (!b) return m;
      return b.type === "math" && b.tag ? PR.t("（式 {tag}）", { tag: b.tag }) : b.page ? PR.t("（第 {page} 页）", { page: b.page }) : m;
    });
  }

  const FOOTNOTE = /(?<!\\)\[\^(\d{1,3}|[*∗†‡§¶]{1,3})\]/g;
  const footnoteNum = (n) => String(n).replace(/∗/g, "*");
  function footnoteRefs(s, opts) {
    return s.replace(FOOTNOTE, (raw, mark) => {
      const n = footnoteNum(mark), ix = PR.footnoteIndex, key = opts.footnotePage + ":" + n;
      const id = ix && (ix.pages.has(key) ? ix.pages.get(key) : ix.all.get(n));
      const label = "<sup>" + n.replace(/\*/g, "&#42;") + "</sup>";
      return id ? '<a class="footnote-ref" href="#b-' + PR.esc(id) + '" data-footnote="b-' + PR.esc(id) + '">' + label + "</a>" : label;
    });
  }

  function inline(text, opts) {
    let s = footnoteRefs(blockLabel(PR.esc(text).replace(/\\\$/g, "$")), opts);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    if (opts.cite !== false) s = citeLinks(s);
    return s.replace(/\n/g, "<br>");
  }

  /* 一行/一段文字 -> HTML */
  PR.md = function (text, opts) {
    opts = opts || {};
    text = String(text == null ? "" : text);
    const saved = tokens(text, false);
    // Some older translations have literal superscripts instead of [^n]. Only use a
    // same-page note after prose. Keep standalone powers, units, code and full TeX intact.
    const noteHere = n => PR.footnoteIndex?.pages.get(opts.footnotePage + ":" + n);
    if (opts.footnotePage != null && PR.footnoteIndex) {
      const proseEnd = /(?:[.。！？!?，,；;：:][ \t]*|(?:^|[\s(])[A-Za-z]{3,}|[\u3400-\u9fff]{2,})$/;
      const inProse = (s, i) => proseEnd.test(s.slice(Math.max(0, i - 80), i));
      saved.text = saved.text.replace(saved.inline, (raw, i, at, str) => {
        const token = saved.values[i];
        const n = !token.code && !token.link && !token.display && token.text.match(/^\^(?:\{(\d{1,3})\}|(\d))$/);
        const num = n && (n[1] || n[2]);
        return num && noteHere(num) && inProse(str, at) ? "[^" + num + "]" : raw;
      }).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (raw, at, str) => {
        const num = raw.normalize("NFKC");
        return noteHere(num) && inProse(str, at) ? "[^" + num + "]" : raw;
      });
    }
    return restore(inline(saved.text, opts), saved, false, opts);
  };

  /* 行间公式先拆出来，再按空行分段；已有回答的 \[...\] 也能显示，不需要改记录。 */
  PR.mdBlocks = function (text, opts) {
    const saved = tokens(String(text || "").trim(), true);
    const html = saved.text.split(saved.blocks).map((part, i) => i % 2 ? tokenHtml(saved.values[part], true, opts) :
      part.split(/\n\s*\n/).map((p) => para(p, opts)).join("")).join("");
    return restore(html, saved, false, opts);
  };

  function isTableDelimiter(line) {
    const trimmed = (line || "").trim();
    if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
    let parts = trimmed.split("|");
    if (trimmed.startsWith("|")) parts.shift();
    if (trimmed.endsWith("|")) parts.pop();
    if (parts.length === 0) return false;
    return parts.every((p) => /^\s*:?-+:?\s*$/.test(p));
  }

  function splitTableRow(line) {
    let s = (line || "").trim();
    const saved = tokens(s, false);
    s = saved.text;
    s = s.replace(/\\\|/g, "\uE002");
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((cell) => {
      let c = cell.trim();
      c = c.replace(/\uE002/g, "|");
      return restore(c, saved, true);
    });
  }

  function parseAlign(delimLine) {
    return splitTableRow(delimLine).map((col) => {
      const c = col.trim();
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
  }

  function tableHtml(headerLine, delimLine, dataLines, opts) {
    const align = parseAlign(delimLine);
    const getStyle = (i) => (align[i] ? ' style="text-align:' + align[i] + '"' : "");
    const headCells = splitTableRow(headerLine);
    const head = "<tr>" + headCells.map((c, i) => "<th" + getStyle(i) + ">" + PR.md(c, opts) + "</th>").join("") + "</tr>";
    const colCount = headCells.length;
    const rows = dataLines.map((rowLine) => {
      const cells = splitTableRow(rowLine);
      while (cells.length < colCount) cells.push("");
      return "<tr>" + cells.slice(0, colCount).map((c, i) => "<td" + getStyle(i) + ">" + PR.md(c, opts) + "</td>").join("") + "</tr>";
    }).join("");
    return '<div class="tbl-wrap"><table class="tbl"><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>";
  }

  function para(p, opts) {
    p = p.trim();
    if (!p) return "";

    // 1. 表格（Markdown GFM 表格：表头 + 分隔行 + 数据行）
    const lines = p.split("\n");
    const dIdx = lines.findIndex((l, idx) => idx >= 1 && isTableDelimiter(l) && lines[idx - 1].includes("|"));
    if (dIdx >= 1) {
      const before = lines.slice(0, dIdx - 1);
      const headerLine = lines[dIdx - 1];
      const delimLine = lines[dIdx];
      let endIdx = dIdx + 1;
      while (endIdx < lines.length && lines[endIdx].includes("|") && lines[endIdx].trim()) {
        endIdx++;
      }
      const dataLines = lines.slice(dIdx + 1, endIdx);
      const after = lines.slice(endIdx);
      return (before.length ? para(before.join("\n"), opts) : "") +
        tableHtml(headerLine, delimLine, dataLines, opts) +
        (after.length ? para(after.join("\n"), opts) : "");
    }

    // 2. 引用块（> 开头）
    const qIdx = lines.findIndex((l) => /^\s*>/.test(l));
    if (qIdx >= 0) {
      let qEnd = qIdx;
      while (qEnd < lines.length && /^\s*>/.test(lines[qEnd])) qEnd++;
      const before = lines.slice(0, qIdx);
      const qText = lines.slice(qIdx, qEnd).map((l) => l.replace(/^\s*>\s?/, "")).join("\n");
      const after = lines.slice(qEnd);
      return (before.length ? para(before.join("\n"), opts) : "") +
        "<blockquote>" + para(qText, opts) + "</blockquote>" +
        (after.length ? para(after.join("\n"), opts) : "");
    }

    // 3. 标题
    const hIdx = lines.findIndex((l) => /^#{1,6}\s+.+$/.test(l));
    if (hIdx >= 0) {
      const h = lines[hIdx].replace(/^#{1,6}\s+/, "");
      return (hIdx ? para(lines.slice(0, hIdx).join("\n"), opts) : "") +
        '<p class="md-h">' + PR.md(h, opts) + "</p>" +
        (hIdx + 1 < lines.length ? para(lines.slice(hIdx + 1).join("\n"), opts) : "");
    }

    // 4. 列表：从某行起每行都以 “- ”“* ”或“1. ”开头（AI 的回答常用“引子：\n- …\n- …”）
    const isItem = (l) => /^\s*([-*•]|\d+[.、)])\s+/.test(l);
    const k = lines.findIndex(isItem);
    if (k >= 0 && lines.slice(k).every(isItem)) {
      const ordered = /^\s*\d/.test(lines[k]);
      const start = ordered ? lines[k].match(/^\s*(\d+)/)[1] : "";
      return (k ? "<p>" + PR.md(lines.slice(0, k).join("\n"), opts) + "</p>" : "") + (ordered ? '<ol' + (start === "1" ? "" : ' start="' + start + '"') + '>' : "<ul>") +
        lines.slice(k).map((l) => "<li>" + PR.md(l.replace(/^\s*([-*•]|\d+[.、)])\s+/, ""), opts) + "</li>").join("") + (ordered ? "</ol>" : "</ul>");
    }

    return "<p>" + PR.md(p, opts) + "</p>";
  }

  /* 去掉标记的纯文字，给目录、列表摘要用 */
  PR.plain = (text) => {
    const saved = tokens(String(text || ""), false);
    return saved.text.replace(saved.inline, (m, i) => saved.values[i].text).replace(/\*\*|`/g, "");
  };
})(window.PR);
