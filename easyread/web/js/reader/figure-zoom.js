/* View original figure or page pixels without changing paper layout or saved notes. */
(function (PR) {
  "use strict";
  const selector = "#paper .figure-media img, #paper .orig-page img";
  let dialog, image, viewport, label, origin, scale = 1, drag, pendingPage = false, pendingBox = null;
  function setScale(next, center) {
    if (!image.naturalWidth) return;
    const old = scale;
    const x = (viewport.scrollLeft + viewport.clientWidth / 2) / old;
    const y = (viewport.scrollTop + viewport.clientHeight / 2) / old;
    scale = Math.max(.05, Math.min(4, next));
    image.style.width = Math.round(image.naturalWidth * scale) + "px";
    image.style.height = Math.round(image.naturalHeight * scale) + "px";
    label.textContent = Math.round(scale * 100) + "%";
    if (center) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
    else {
      viewport.scrollLeft = x * scale - viewport.clientWidth / 2;
      viewport.scrollTop = y * scale - viewport.clientHeight / 2;
    }
  }
  function fit() {
    setScale(Math.min(1, (viewport.clientWidth - 24) / image.naturalWidth,
      (viewport.clientHeight - 24) / image.naturalHeight), true);
  }
  function applyInitialView() {
    if (!image.naturalWidth) return;
    if (!pendingPage) {
      fit();
      return;
    }
    const nextScale = Math.min(1, Math.max(0.5, (viewport.clientWidth - 24) / (image.naturalWidth * 0.84)));
    setScale(nextScale, true);
    const imgW = Math.round(image.naturalWidth * scale);
    const imgH = Math.round(image.naturalHeight * scale);
    if (pendingBox) {
      const [x0, y0, x1, y1] = pendingBox;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const boxH = (y1 - y0) * imgH;
      viewport.scrollLeft = Math.max(0, Math.round(cx * imgW - viewport.clientWidth / 2));
      if (boxH > viewport.clientHeight * 0.82) {
        viewport.scrollTop = Math.max(0, Math.round(y0 * imgH - 36));
      } else {
        viewport.scrollTop = Math.max(0, Math.round(cy * imgH - viewport.clientHeight / 2));
      }
    } else {
      viewport.scrollLeft = Math.max(0, Math.round((imgW - viewport.clientWidth) / 2));
      viewport.scrollTop = 0;
    }
  }
  function create() {
    dialog = document.createElement("dialog");
    dialog.className = "figure-viewer";
    dialog.setAttribute("aria-label", PR.t("查看图片"));
    dialog.innerHTML = '<div class="figure-viewer-tools"><button class="btn icon" data-zoom="out" aria-label="' + PR.t("缩小图片") + '">−</button><span class="figure-viewer-scale" aria-live="polite"></span><button class="btn icon" data-zoom="in" aria-label="' + PR.t("放大图片") + '">+</button><button class="btn sm" data-zoom="fit">' + PR.t("适合窗口") + '</button><button class="btn sm" data-zoom="actual">100%</button><span class="grow"></span><button class="btn icon" data-zoom="close" aria-label="' + PR.t("关闭") + '">×</button></div><div class="figure-viewer-scroll" tabindex="0"><div class="figure-viewer-canvas"><img alt="" draggable="false"></div></div>';
    document.body.appendChild(dialog);
    image = dialog.querySelector("img");
    viewport = dialog.querySelector(".figure-viewer-scroll");
    label = dialog.querySelector(".figure-viewer-scale");
    image.onload = applyInitialView;
    image.onerror = () => { dialog.close(); PR.toast(PR.t("图片未能加载，请查看原页")); };
    dialog.addEventListener("close", () => { drag = null; origin?.focus({ preventScroll: true }); });
    dialog.addEventListener("click", e => {
      const action = e.target.closest("[data-zoom]")?.dataset.zoom;
      if (action === "close") dialog.close();
      else if (action === "fit") fit();
      else if (action === "actual") setScale(1);
      else if (action) setScale(scale * (action === "in" ? 1.25 : .8));
    });
    viewport.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); setScale(scale * (e.deltaY < 0 ? 1.25 : .8));
    }, { passive: false });
    viewport.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("panning");
      e.preventDefault();
    });
    viewport.addEventListener("pointermove", e => {
      if (!drag) return;
      viewport.scrollLeft = drag.left + drag.x - e.clientX;
      viewport.scrollTop = drag.top + drag.y - e.clientY;
    });
    const stop = () => { drag = null; viewport.classList.remove("panning"); };
    viewport.addEventListener("pointerup", stop);
    viewport.addEventListener("pointercancel", stop);
    viewport.addEventListener("lostpointercapture", stop);
  }
  function pageSource(pageNum) {
    const n = Number(pageNum);
    if (!n || n < 1) return "";
    const pages = (((PR.state || {}).paper || {}).meta || {}).pages || [];
    const entry = pages.find(p => Number(p.n) === n) || pages[n - 1];
    const rel = (entry && entry.img) || ("pages/page-" + String(n).padStart(3, "0") + ".webp");
    return PR.imageUrl ? PR.imageUrl(rel) : rel;
  }
  function blockBoxOf(zoomBtn, pageNum) {
    const blockId = (zoomBtn.dataset && zoomBtn.dataset.zoomBlock) || zoomBtn.closest?.(".blk")?.dataset?.id || "";
    if (!blockId) return null;
    const layout = ((PR.state || {}).layout) || {};
    const loc = layout[blockId];
    if (!loc || (loc.page && Number(loc.page) !== Number(pageNum))) return null;
    const boxes = Array.isArray(loc.boxes) && loc.boxes.length
      ? loc.boxes
      : (Array.isArray(loc.box) && loc.box.length === 4 ? [loc.box] : []);
    if (!boxes.length) return null;
    return [
      Math.min(...boxes.map(b => Number(b[0]))),
      Math.min(...boxes.map(b => Number(b[1]))),
      Math.max(...boxes.map(b => Number(b[2]))),
      Math.max(...boxes.map(b => Number(b[3]))),
    ];
  }
  function open(source, customSrc, customAlt, isPage, focusBox) {
    if (!dialog) create();
    origin = source;
    pendingPage = !!isPage;
    pendingBox = focusBox || null;
    image.alt = customAlt || source.alt || PR.t("查看图片");
    image.src = customSrc || source.currentSrc || source.src;
    scale = 1;
    dialog.showModal();
    if (image.complete && image.naturalWidth) applyInitialView();
  }
  function prepare() {
    document.querySelectorAll(selector).forEach(img => {
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute("aria-label", PR.t("点击放大图片"));
      img.title = PR.t("点击放大图片");
    });
  }
  PR.on("rendered", prepare);
  PR.on("block-rendered", prepare);
  document.addEventListener("click", e => {
    const zoomBtn = e.target.closest?.("[data-zoom-page]");
    if (zoomBtn && zoomBtn.dataset && zoomBtn.dataset.zoomPage) {
      const pageNum = Number(zoomBtn.dataset.zoomPage);
      const src = pageSource(pageNum);
      if (!src) return;
      e.preventDefault(); e.stopImmediatePropagation();
      open(zoomBtn, src, PR.t("原文第 {n} 页", { n: pageNum }), true, blockBoxOf(zoomBtn, pageNum));
      return;
    }
    const source = e.target.closest?.(selector);
    if (!source) return;
    e.preventDefault(); e.stopImmediatePropagation(); open(source);
  }, true);
  document.addEventListener("keydown", e => {
    if (dialog?.open) {
      // Reader shortcuts must not run underneath the modal; Tab stays native.
      e.stopImmediatePropagation();
      if (e.key === "Escape") { e.preventDefault(); dialog.close(); }
      else if (["+", "=", "-", "0"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "0") fit(); else setScale(scale * (e.key === "-" ? .8 : 1.25));
      }
    } else if (["Enter", " "].includes(e.key)) {
      const zoomBtn = e.target.closest?.("[data-zoom-page]");
      if (zoomBtn && zoomBtn.dataset && zoomBtn.dataset.zoomPage) {
        const pageNum = Number(zoomBtn.dataset.zoomPage);
        const src = pageSource(pageNum);
        if (src) {
          e.preventDefault(); e.stopImmediatePropagation();
          open(zoomBtn, src, PR.t("原文第 {n} 页", { n: pageNum }), true, blockBoxOf(zoomBtn, pageNum));
        }
      } else if (e.target.matches?.(selector)) {
        e.preventDefault(); e.stopImmediatePropagation(); open(e.target);
      }
    }
  }, true);
})(window.PR);
