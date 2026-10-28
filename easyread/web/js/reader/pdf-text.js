/* Reuse extracted PDF characters: selectable text over the original page image. */
(function (PR) {
  "use strict";
  const cache = new Map(), roots = new Set(), states = new WeakMap();
  PR.pdfTextSelectionIn = function (parent) {
    const selection = getSelection(), layer = parent.querySelector(".pdf-text-layer");
    return !!(layer && selection && !selection.isCollapsed && selection.rangeCount &&
      selection.getRangeAt(0).intersectsNode(layer));
  };
  const canvas = document.createElement("canvas"), measure = canvas.getContext("2d");
  const resize = new ResizeObserver(entries => entries.forEach(({target}) => {
    const content = target.firstElementChild;
    if (content) content.style.transform = "scale(" + target.clientWidth / states.get(target).page.w + ")";
  }));
  async function show(root) {
    const state = states.get(root), page = state.page;
    if (root.firstChild || state.loading) return;
    state.loading = true;
    try {
      let chars = cache.get(page.n);
      if (!chars) {
        const response = await fetch(PR.imageUrl("extract/page-" + String(page.n).padStart(3, "0") + ".chars.json") + "?selection=2");
        if (!response.ok) throw Error("No extracted text");
        chars = await response.json();
        if (!Array.isArray(chars) || chars.length > 100000) throw Error("Invalid PDF text");
        cache.set(page.n, chars);
        if (cache.size > 12) cache.delete(cache.keys().next().value);
      }
      if (!state.visible || !root.isConnected) return;
      const content = document.createElement("div");
      content.className = "pdf-text-content";
      content.style.cssText = "width:" + page.w + "px;height:" + page.h + "px;transform:scale(" + root.clientWidth / page.w + ")";
      const fragment = document.createDocumentFragment();
      let previous = null;
      for (const row of chars) {
        if (!Array.isArray(row) || row.length !== 5 || typeof row[0] !== "string" || !row.slice(1).every(Number.isFinite)) continue;
        const [text, x0, y0, x1, y1] = row;
        if (/^\s+$/.test(text)) {
          fragment.append(document.createTextNode(text));
          if (/[\r\n]/.test(text)) previous = null;
          continue;
        }
        if (previous && Math.abs(y0 - previous[2]) > Math.max(y1 - y0, previous[4] - previous[2]) * .6) fragment.append(document.createTextNode("\n"));
        previous = row;
        const height = Math.max(1, (y1 - y0) * page.h), width = Math.max(0, (x1 - x0) * page.w);
        const span = document.createElement("span");
        span.textContent = text;
        measure.font = height + "px sans-serif";
        const natural = measure.measureText(text).width;
        span.style.cssText = "left:" + x0 * page.w + "px;top:" + y0 * page.h + "px;font-size:" + height + "px;line-height:1;height:" + height + "px;transform:scaleX(" + (natural && width ? width / natural : 1) + ")";
        fragment.append(span);
      }
      content.append(fragment); root.replaceChildren(content);
      root.style.pointerEvents = chars.length ? "auto" : "none";
      if (!chars.length) root.parentElement.title = PR.t("这一页没有可选文字，可能是扫描页");
    } catch (error) {
      root.style.pointerEvents = "none";
      root.parentElement.title = PR.t("这一页的文字暂未提取，可先阅读原图");
    } finally { state.loading = false; }
  }
  const observer = new IntersectionObserver(entries => entries.forEach(({target, isIntersecting}) => {
    const state = states.get(target); state.visible = isIntersecting;
    if (isIntersecting) show(target);
    else {
      const selection = getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.getRangeAt(0).intersectsNode(target)) target.replaceChildren();
    }
  }), {rootMargin: "600px"});
  PR.attachPdfText = function (parent, image, number) {
    if (PR.store.mode !== "server") return;
    if (parent.querySelector(".pdf-text-layer")) return;
    const raw = (PR.state.paper.meta.pages || []).find(p => p.n === number);
    if (!raw) return;
    const page = {n:number, w:Number(raw.w) || 612, h:Number(raw.h) || 792};
    let surface = parent;
    if (parent.classList.contains("orig-page")) {
      surface = document.createElement("div"); surface.className = "pdf-page-surface";
      image.replaceWith(surface); surface.append(image);
    }
    const root = document.createElement("div"); root.className = "pdf-text-layer";
    root.setAttribute("aria-label", PR.t("第 {page} 页文字，可选择和复制", {page:number}));
    states.set(root, {page, loading:false, visible:false});
    surface.append(root); roots.add(root); resize.observe(root); observer.observe(root);
  };
  PR.on("rendered", () => {
    for (const root of roots) if (!root.isConnected) { observer.unobserve(root); resize.unobserve(root); roots.delete(root); }
    PR.$$("#paper .orig-page").forEach(parent => PR.attachPdfText(parent, parent.querySelector("img"), Number(parent.id.slice(5))));
  });
  document.addEventListener("copy", event => {
    const selection = getSelection();
    if (!event.clipboardData || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0), node = range.startContainer;
    if (!(node.nodeType === 1 ? node : node.parentElement).closest(".pdf-text-content")) return;
    // Positioned character spans otherwise copy with a newline after every character.
    event.clipboardData.setData("text/plain", range.cloneContents().textContent.replace(/\r\n?/g, "\n"));
    event.preventDefault();
  });
})(window.PR);
