/* One on-demand renderer for figure/table hovers and side-panel previews. */
(function (PR) {
  "use strict";
  const isMedia = (b) => b && (b.type === "figure" || b.type === "table");
  const blocks = () => ((PR.state.paper && PR.state.paper.blocks) || []).filter(isMedia);
  const figureBlocks = () => ((PR.state.paper && PR.state.paper.blocks) || []).filter((b) => b && b.type === "figure");
  const caption = (b) => PR.plain(PR.textFor(b.id + "#caption") || b.caption_en || b.caption_zh || "");
  const label = (b) => (b.type === "table" ? PR.t("表 {n}", { n: b.num || "" }) : PR.t("图 {n}", { n: b.num || "" })).trim();
  const reference = (b) => ({ id: b.id, type: b.type, num: String(b.num || ""), page: b.page, caption: caption(b).slice(0, 160) });
  function resolve(ref) {
    if (!ref) return null;
    const same = (b) => isMedia(b) && b.type === ref.type && String(b.num || "") === String(ref.num || "");
    const exact = PR.blockById && PR.blockById[ref.id];
    if (same(exact)) return exact;
    const matches = ref.num ? blocks().filter((b) => same(b) && b.page === ref.page) : [];
    return matches.length === 1 ? matches[0] : null;
  }
  function tableHtml(b, compact = false) {
    if (typeof PR.tableParts === "function") {
      const { head, rows, notes } = PR.tableParts(b);
      const colCount = Math.max(0, ...head.map((r) => r.length), ...rows.map((r) => r.length));
      const dataTable = typeof PR.isDataTable === "function" ? PR.isDataTable(rows, colCount) : false;
      const cellAttr = (c, isHead, i) => {
        const cls = typeof PR.tableCellClass === "function" ? PR.tableCellClass(c, isHead, i, colCount, dataTable) : "";
        return cls ? ' class="' + cls + '"' : "";
      };
      const bodyRows = compact ? rows.slice(0, 4) : rows;
      const groups = typeof PR.tableGroupRows === "function" ? PR.tableGroupRows(bodyRows) : new Set();
      const cells = (rs, tag, isBody) => rs.map((r, rIdx) => "<tr" + (isBody && groups.has(rIdx) ? ' class="tbl-group"' : "") + ">" + r.map((c, i) => "<" + tag + cellAttr(c, tag === "th", i) + ">" + PR.md(String(c ?? ""), { cite: false, xref: false }) + "</" + tag + ">").join("") + "</tr>").join("");
      return '<div class="media-table-scroll"' + (compact ? "" : ' tabindex="0"') + "><table><thead>" + cells(head, "th", false) + "</thead><tbody>" + cells(bodyRows, "td", true) + "</tbody></table></div>" + (compact || !PR.tableNotesHtml ? "" : PR.tableNotesHtml(notes, b));
    }
    return '<p class="media-empty">' + PR.t("表格位於原文第 {n} 頁", { n: b.page || "?" }) + "</p>";
  }
  function html(ref) {
    const b = resolve(ref);
    if (!b) return '<p class="media-empty">' + PR.t("这张图表已变化或移除，请重新关联") + "</p>" + (ref.page ? '<button class="btn sm" data-media-page="' + Number(ref.page) + '">' + PR.t("查看原页") + "</button>" : "");
    let content;
    if (b.type === "table") content = tableHtml(b);
    else if (b.src) content = '<div class="media-image"><img src="' + PR.esc(PR.imageUrl(b.src)) + '" alt="' + PR.esc(label(b)) + '" decoding="async"><span class="media-image-error" hidden>' + PR.t("图片未能加载，请查看原页") + "</span></div>";
    else content = '<p class="media-empty">' + PR.t("尚无图像，可查看 PDF 原页") + "</p>";
    const cropBtn = b.type === "figure" && PR.store && PR.store.mode === "server" && PR.cropFigure
      ? '<button class="btn sm" data-media-crop="' + PR.esc(b.id) + '">' + PR.t("重新截取图片") + "</button>" : "";
    return '<div class="media-preview" data-media-block="' + PR.esc(b.id) + '">' + content +
      '<div class="media-caption">' + PR.esc(caption(b)) + '</div>' +
      '<div class="media-footer"><span>' + PR.t("第 {page} 页", { page: b.page || "?" }) + "</span>" +
      '<button class="btn sm" data-media-go="' + PR.esc(b.id) + '">' + PR.t("定位正文") + "</button>" +
      (b.page ? '<button class="btn sm" data-media-page="' + Number(b.page) + '" data-media-block="' + PR.esc(b.id) + '">PDF</button>' : "") +
      cropBtn + "</div></div>";
  }
  function hover(anchor, b) {
    if (!b) return;
    const pinBtn = b.type === "figure" && PR.pinDockFigure
      ? '<button class="btn sm" data-dock-pin="' + PR.esc(b.id) + '">' + PR.t("在侧栏打开") + "</button>" : "";
    PR.popover(anchor, '<div class="media-hover"><div class="media-title">' + PR.esc(label(b)) + "</div>" + html(reference(b)) + pinBtn + "</div>", { wide: true });
  }
  document.addEventListener("click", (e) => {
    const pin = e.target.closest("[data-dock-pin]");
    if (pin) { e.preventDefault(); e.stopPropagation(); PR.pinDockFigure?.(pin.dataset.dockPin); PR.hidePopover(); return; }
    const crop = e.target.closest("[data-media-crop]");
    if (crop) { e.preventDefault(); e.stopPropagation(); PR.hidePopover(); PR.cropFigure?.(crop.dataset.mediaCrop); return; }
    const go = e.target.closest("[data-media-go]"), page = e.target.closest("[data-media-page]");
    if (!go && !page) return;
    e.preventDefault(); e.stopPropagation(); PR.hidePopover();
    if (go) PR.jumpTo("b-" + go.dataset.mediaGo);
    else PR.openPage(Number(page.dataset.mediaPage), page.dataset.mediaBlock);
  }, true);
  document.addEventListener("error", (e) => {
    if (!e.target.matches || !e.target.matches(".media-image img")) return;
    e.target.hidden = true;
    if (e.target.nextElementSibling) e.target.nextElementSibling.hidden = false;
  }, true);
  PR.media = { isMedia, blocks, figureBlocks, label, caption, reference, resolve, html, hover };
})(window.PR);
