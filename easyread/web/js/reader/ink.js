/* PaperRead ink strokes: SVG paths anchored to a paragraph's saved geometry. */
(function (PR) {
  "use strict";
  const layer = document.getElementById("inkLayer"), tools = document.getElementById("inkTools");
  const colors = ["#1d1d1d", "#d94b4b", "#2878c8", "#27845b"];
  const colorOk = value => /^#[0-9a-f]{6}$/i.test(value);
  let active = false, hidden = false, erasing = false, color = colors[0], width = 2, drawing = null, erasingStrokes = null, last = null, erasePrevious = null, eraseCursor = null, eraserWidth = 24, textMode = false;
  const undo = [], redo = [];
  const strokes = () => Object.values(PR.state.reader.ink || {}).filter(stroke => !stroke.deleted);
  const stage = () => document.getElementById("stage");
  const now = () => Date.now();
  const point = (e, rect) => [e.clientX - rect.left, e.clientY - rect.top];
  const finite = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;

  function pathData(points) {
    if (points.length === 1) return `M${finite(points[0][0])} ${finite(points[0][1])}l.01 0`;
    let d = `M${finite(points[0][0])} ${finite(points[0][1])}`;
    for (let i = 1; i < points.length - 1; i++) {
      const mid = [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2];
      d += `Q${finite(points[i][0])} ${finite(points[i][1])} ${finite(mid[0])} ${finite(mid[1])}`;
    }
    const end = points[points.length - 1];
    return d + `L${finite(end[0])} ${finite(end[1])}`;
  }

  function render() {
    if (!layer) return;
    const host = stage(), sr = host.getBoundingClientRect();
    layer.setAttribute("viewBox", `0 0 ${Math.max(1, host.clientWidth)} ${Math.max(1, host.scrollHeight)}`);
    layer.style.width = host.clientWidth + "px"; layer.style.height = host.scrollHeight + "px";
    layer.replaceChildren();
    PR.renderStickers?.(layer, sr, host, "back");
    for (const stroke of hidden ? [] : strokes()) {
      if (!colorOk(stroke.color) || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 12 ||
          !Array.isArray(stroke.ref) || stroke.ref.length !== 2 || stroke.ref.some(v => !Number.isFinite(v) || v < 1 || v > 5000) ||
          !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 2000 ||
          stroke.points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 5000))) continue;
      const block = document.getElementById("b-" + stroke.anchor);
      if (!block) continue;
      const r = block.getBoundingClientRect(), sx = r.width / stroke.ref[0], sy = r.height / stroke.ref[1];
      // shortcut: hide a stroke when its text or aspect ratio changes; add multi-block anchors for cross-paragraph alignment.
      if (!r.width || !r.height || PR.hashText(block.innerText || "") !== stroke.textHash || Math.abs(sx - sy) > Math.max(sx, sy) * .05) continue;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.dataset.stroke = stroke.id;
      path.setAttribute("d", pathData(stroke.points));
      path.setAttribute("transform", `translate(${r.left - sr.left} ${r.top - sr.top + host.scrollTop}) scale(${sx})`);
      path.setAttribute("fill", "none"); path.setAttribute("stroke", stroke.color);
      path.setAttribute("stroke-width", stroke.width); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      if (PR.stickerMode && PR.isInkSelected?.(stroke.id)) {
        const outline=document.createElementNS("http://www.w3.org/2000/svg", "path");
        outline.setAttribute("d",path.getAttribute("d")); outline.setAttribute("transform",path.getAttribute("transform"));
        outline.setAttribute("fill","none"); outline.setAttribute("stroke","#2878c8"); outline.setAttribute("stroke-width",stroke.width+5);
        outline.setAttribute("stroke-linecap","round"); outline.setAttribute("stroke-linejoin","round"); outline.setAttribute("stroke-opacity",".6"); outline.setAttribute("vector-effect","non-scaling-stroke"); outline.setAttribute("pointer-events","none");
        layer.append(outline);
      }
      layer.append(path);
    }
    PR.renderStickers?.(layer, sr, host, "front");
  }
  PR.renderInk = render;

  function nearestBlock(y) {
    const candidates = PR.$$("#paper > .blk[data-id]");
    let best = null, distance = Infinity;
    for (const block of candidates) {
      const r = block.getBoundingClientRect();
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (d < distance) { best = block; distance = d; }
    }
    return best;
  }
  function addStroke(stroke) {
    PR.commit({ op: "ink", stroke });
    undo.push({ add: [stroke] }); redo.length = 0; render();
  }
  function replay(entry, undoing) {
    if (entry.selection) {
      const content = value => {
        if (!value || value.deleted) return "deleted";
        const clean={...value}; delete clean.updated; delete clean.deleted;
        return JSON.stringify(clean, (_key,item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
      };
      const expected=undoing ? "after" : "before";
      const changed=(entry.selection.stickers || []).some(item=>content(PR.state.reader.stickers?.[item.id])!==content(item[expected])) ||
        (entry.selection.ink || []).some(item=>content(PR.state.reader.ink?.[item.id])!==content(item[expected]));
      if (changed) { undo.length=redo.length=0; PR.toast(PR.t("選取內容已在其他地方修改，無法復原")); return false; }
      for (const item of entry.selection.stickers || []) {
        const value=undoing ? item.before : item.after;
        if (value) PR.commit({op:"sticker",sticker:{...value,deleted:false}}); else PR.commit({op:"sticker_del",id:item.id});
      }
      for (const item of entry.selection.ink || []) {
        const value=undoing ? item.before : item.after;
        if (value) PR.commit({op:"ink",stroke:{...value,deleted:false}}); else PR.commit({op:"ink_del",id:item.id});
      }
      render(); return true;
    }
    if (entry.stickers) {
      const content = value => {
        if (!value || value.deleted) return "deleted";
        const clean={...value}; delete clean.updated; delete clean.deleted;
        return JSON.stringify(clean, (_key,item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
      };
      if (entry.stickers.some(item => content(PR.state.reader.stickers?.[item.id]) !== content(undoing ? item.after : item.before))) {
        undo.length = redo.length = 0; PR.toast(PR.t("貼紙已在其他地方修改，無法復原")); return false;
      }
      for (const item of entry.stickers) {
        const value=undoing ? item.before : item.after;
        if (value) PR.commit({op:"sticker",sticker:{...value,deleted:false}}); else PR.commit({op:"sticker_del",id:item.id});
      }
      render(); return true;
    }
    if (entry.sticker) {
      const content = value => {
        if (!value || value.deleted) return "deleted";
        const clean = { ...value }; delete clean.updated; delete clean.deleted;
        return JSON.stringify(clean, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
      };
      if (content(PR.state.reader.stickers?.[entry.id]) !== content(undoing ? entry.after : entry.before)) {
        undo.length = redo.length = 0; PR.toast(PR.t("貼紙已在其他地方修改，無法復原")); return false;
      }
      const value = undoing ? entry.before : entry.after;
      if (value) PR.commit({ op: "sticker", sticker: { ...value, deleted: false } });
      else PR.commit({ op: "sticker_del", id: entry.id });
      render();
      return true;
    }
    const restore = undoing ? entry.remove : entry.add, remove = undoing ? entry.add : entry.remove;
    for (const stroke of restore || []) PR.commit({ op: "ink", stroke: { ...stroke, deleted: false } });
    for (const stroke of remove || []) PR.commit({ op: "ink_del", id: stroke.id });
    render();
    return true;
  }
  PR.recordStickerHistory = (id, before, after) => { undo.push({ sticker: true, id, before, after }); redo.length = 0; };
  PR.recordStickerBatchHistory = entries => { if (entries.length) { undo.push({ stickers:entries }); redo.length=0; } };
  PR.recordSelectionHistory = (stickers, ink) => { if (stickers.length || ink.length) { undo.push({selection:{stickers,ink}}); redo.length=0; } };
  PR.inkHistory = isRedo => {
    const from = isRedo ? redo : undo, to = isRedo ? undo : redo;
    if (!from.length) return false;
    const entry = from.pop(); if (!replay(entry, !isRedo)) return true; to.push(entry); return true;
  };
  function finish() {
    if (!drawing) return;
    const stroke = drawing; drawing = null;
    if (stroke.points.length) addStroke(stroke);
  }
  function eraseAt(e, gesture) {
    const next = { x:e.clientX, y:e.clientY }, previous = erasePrevious || next;
    const hits = [...layer.querySelectorAll("path[data-stroke]")].filter(path => PR.inkEraser.hitPath(path, previous, next, eraserWidth / 2));
    erasePrevious = next;
    for (const path of hits) {
      const stroke = PR.state.reader.ink[path.dataset.stroke];
      if (stroke && !stroke.deleted) { PR.commit({ op:"ink_del", id:stroke.id }); if (gesture) gesture.push(stroke); }
    }
    if (hits.length) render();
  }
  function cursor(e) {
    if (!eraseCursor) { eraseCursor = document.createElement("div"); eraseCursor.className = "ink-eraser-cursor"; document.body.append(eraseCursor); }
    eraseCursor.style.width = eraseCursor.style.height = eraserWidth + "px";
    eraseCursor.style.left = e.clientX + "px"; eraseCursor.style.top = e.clientY + "px"; eraseCursor.hidden = !active || !erasing;
  }
  function finishErase() {
    if (!erasingStrokes) return;
    if (erasingStrokes.length) { undo.push({ remove: erasingStrokes }); redo.length = 0; }
    erasingStrokes = null; erasePrevious = null;
  }
  function showEraserSize(show) {
    const popup=tools.querySelector("[data-eraser-size]"), button=tools.querySelector("[data-ink-erase]");
    if (popup) popup.hidden=!show;
    button?.setAttribute("aria-expanded",String(show));
  }
  function setEraser(on) {
    if (!on) { finishErase(); if (eraseCursor) eraseCursor.hidden=true; showEraserSize(false); }
    erasing=on; layer.classList.toggle("erase",on);
    tools.querySelector("[data-ink-erase]")?.setAttribute("aria-pressed",String(on));
  }
  PR.setInkEraser = setEraser;

  layer.addEventListener("pointerdown", e => {
    if (!active || e.button !== 0 || PR.stickerMode) return;
    e.preventDefault();
    if (textMode) {
      textMode = false; tools.querySelector("[data-ink-text]")?.setAttribute("aria-pressed", "false");
      const group=e.target.closest?.("[data-sticker]"), item=group && PR.state.reader.stickers?.[group.dataset.sticker];
      if (item?.assetId === "paperread-text-box") PR.setStickerMode?.(true);
      else PR.insertInkText?.(e.clientX, e.clientY);
      return;
    }
    if (erasing) { erasingStrokes = []; layer.setPointerCapture(e.pointerId); eraseAt(e, erasingStrokes); return; }
    const block = nearestBlock(e.clientY);
    if (!block) return;
    const r = block.getBoundingClientRect(), p = point(e, r);
    const group = last && last.anchor === block.dataset.id && last.color === color && last.width === width && now() - last.time < 8000 &&
      Math.hypot(p[0] - last.point[0], p[1] - last.point[1]) < 90 ? last.group : PR.uid("ink");
    drawing = { id: PR.uid("ink"), group, anchor: block.dataset.id, ref: [r.width, r.height], textHash: PR.hashText(block.innerText || ""), points: [p], color, width, created: PR.nowIso() };
    layer.setPointerCapture(e.pointerId);
  });
  layer.addEventListener("pointermove", e => {
    if (active && erasing) cursor(e);
    if (drawing) {
      const block = document.getElementById("b-" + drawing.anchor), r = block.getBoundingClientRect(), p = point(e, r);
      const prev = drawing.points[drawing.points.length - 1];
      if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= 1.2) {
        if (drawing.points.length < 2000) drawing.points.push(p); else drawing.points[1999] = p;
        renderPreview();
      }
    } else if (active && erasing && erasingStrokes && (e.buttons & 1)) eraseAt(e, erasingStrokes);
  });
  layer.addEventListener("pointerleave", () => { if (eraseCursor && !erasingStrokes) eraseCursor.hidden = true; });
  layer.addEventListener("pointerup", e => {
    if (drawing) { const d = drawing; finish(); last = { anchor: d.anchor, color: d.color, width: d.width, time: now(), point: d.points[d.points.length - 1], group: d.group }; }
    finishErase();
    if (eraseCursor) eraseCursor.hidden = true;
  });
  layer.addEventListener("pointercancel", () => { finish(); finishErase(); });
  window.addEventListener("blur", () => { finish(); finishErase(); });
  window.addEventListener("scroll", () => { finish(); finishErase(); }, { passive: true });
  function renderPreview() {
    render();
    const r = document.getElementById("b-" + drawing.anchor).getBoundingClientRect(), sr = stage().getBoundingClientRect();
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData(drawing.points)); path.setAttribute("transform", `translate(${r.left - sr.left} ${r.top - sr.top + stage().scrollTop})`);
    path.setAttribute("fill", "none"); path.setAttribute("stroke", drawing.color); path.setAttribute("stroke-width", drawing.width);
    path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round"); layer.append(path);
  }

  document.getElementById("inkToggle")?.addEventListener("click", () => {
    active = !active; tools.hidden = !active; layer.classList.toggle("active", active);
    document.getElementById("inkToggle").setAttribute("aria-pressed", String(active));
    if (!active) { finish(); setEraser(false); PR.setLassoMode?.(false); textMode = false; tools.querySelector("[data-ink-text]")?.setAttribute("aria-pressed", "false"); }
  });
  PR.toggleInk = () => document.getElementById("inkToggle")?.click();
  PR.toggleInkEraser = () => {
    if (!active) PR.toggleInk();
    setEraser(!erasing); showEraserSize(erasing);
  };
  function setColor(next, button) {
    if (!colorOk(next)) return;
    if (erasing) setEraser(false);
    PR.setLassoMode?.(false); textMode = false; tools.querySelector("[data-ink-text]")?.setAttribute("aria-pressed", "false");
    color = next.toLowerCase();
    const custom = tools.querySelector("[data-ink-custom]");
    const customSwatch = custom?.closest(".ink-custom");
    tools.querySelectorAll("[data-ink-color], .ink-custom").forEach(b => b.setAttribute("aria-pressed", String(b === button || (button === custom && b === customSwatch))));
    if (customSwatch) customSwatch.style.setProperty("--ink-color", color);
    if (custom && button === custom) custom.value = color;
  }
  function setWidth(next) {
    width = Math.max(1, Math.min(12, Number(next) || 2));
    const input = tools.querySelector("[data-ink-width]");
    if (input) input.value = String(width);
  }
  tools.addEventListener("click", e => {
    const button = e.target.closest("button"); if (!button) return;
    if (button.dataset.inkColor) { PR.setStickerMode?.(false); setColor(button.dataset.inkColor, button); }
    if (button.hasAttribute("data-ink-erase")) { PR.setStickerMode?.(false); textMode = false; tools.querySelector("[data-ink-text]")?.setAttribute("aria-pressed", "false"); setEraser(true); showEraserSize(true); }
    if (button.hasAttribute("data-ink-lasso")) { setEraser(false); textMode=false; tools.querySelector("[data-ink-text]")?.setAttribute("aria-pressed","false"); PR.setLassoMode?.(!PR.lassoMode); button.setAttribute("aria-pressed",String(!!PR.lassoMode)); }
    if (button.hasAttribute("data-ink-text")) { PR.setLassoMode?.(false); PR.setStickerMode?.(false); setEraser(false); textMode = !textMode; button.setAttribute("aria-pressed", String(textMode)); }
    if (button.hasAttribute("data-ink-hide")) { hidden = !hidden; button.setAttribute("aria-pressed", String(hidden)); const label = button.querySelector("[data-ink-hide-label]"); if (label) label.textContent = hidden ? PR.t("顯示筆跡") : PR.t("隱藏筆跡"); render(); }
    if (button.hasAttribute("data-ink-undo")) PR.inkHistory(false);
    if (button.hasAttribute("data-ink-redo")) PR.inkHistory(true);
  });
  tools.addEventListener("input", e => {
    if (e.target.matches("[data-ink-width]")) setWidth(e.target.value);
    if (e.target.matches("[data-eraser-width]")) { eraserWidth = Math.max(8, Math.min(80, Number(e.target.value) || 24)); if (eraseCursor) eraseCursor.style.width = eraseCursor.style.height = eraserWidth + "px"; }
    if (e.target.matches("[data-ink-custom]")) { PR.setStickerMode?.(false); setColor(e.target.value, e.target); }
  });
  document.addEventListener("pointerdown", e => { if (!e.target.closest?.(".ink-eraser")) showEraserSize(false); });
  document.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.isComposing || e.target.closest?.("input,textarea,select,[contenteditable],#chatStyleHelp")) return;
    if (!active) return;
    if (e.key === "Escape") {
      PR.setLassoMode?.(false); PR.setStickerMode?.(false);
      if (tools.querySelector("[data-eraser-size]")?.hidden === false) { e.preventDefault(); e.stopImmediatePropagation(); showEraserSize(false); tools.querySelector("[data-ink-erase]")?.focus(); return; }
      e.preventDefault(); e.stopImmediatePropagation(); active = false; tools.hidden = true; setEraser(false);
      layer.classList.remove("active"); textMode = false; tools.querySelector("[data-ink-text]")?.setAttribute("aria-pressed", "false"); tools.querySelector("[data-ink-lasso]")?.setAttribute("aria-pressed", "false"); document.getElementById("inkToggle").setAttribute("aria-pressed", "false");
      finish(); return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key.toLowerCase() === "z" && PR.inkHistory(e.shiftKey)) e.preventDefault();
    if (e.key.toLowerCase() === "y" && PR.inkHistory(true)) e.preventDefault();
  });
  const layoutObserver = new ResizeObserver(PR.debounce(() => { if (drawing) finish(); render(); }, 100));
  layoutObserver.observe(document.getElementById("paper")); layoutObserver.observe(stage());
  PR.on("reader", op => { if (op?.op === "ink" || op?.op === "ink_del") render(); });
  PR.on("remote", changed => { if (changed.includes("paper") || changed.includes("reader")) setTimeout(render, 0); });
})(window.PR);
