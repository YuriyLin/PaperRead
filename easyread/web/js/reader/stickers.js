/* Stickers share the paragraph-anchored ink layer and its local undo history. */
(function (PR) {
  "use strict";
  const panel = document.getElementById("stickerPanel"), toggle = document.getElementById("stickerToggle");
  const bar = document.getElementById("stickerTools"), layer = document.getElementById("inkLayer");
  const ns = "http://www.w3.org/2000/svg", esc = PR.esc;
  const storageKey = "paperread-sticker-library";
  let assets = [], preview = null, selected = null, selectedIds = new Set(), selectedInkIds = new Set(), gesture = null, lasso = null, offlineLicenses = null;
  let filter = "all", category = "", query = "", settings = PR.ls.get(storageKey, { favorites: [], recent: [], custom: [] });
  if (!settings || !Array.isArray(settings.favorites) || !Array.isArray(settings.recent) || !Array.isArray(settings.custom)) settings = { favorites: [], recent: [], custom: [] };
  const saveSettings = () => { const ok = PR.ls.set(storageKey, settings); if (!ok) PR.toast(PR.t("無法儲存貼紙偏好，瀏覽器儲存空間不足")); return ok; };
  const allAssets = () => [...assets, ...settings.custom.filter(a => a && /^custom-[a-z0-9]+$/.test(a.id) && validData(a.customData))];
  const assetOf = id => { if (id === "paperread-text-box") return { id, name:PR.t("文字方塊"), source:"text" }; const stored = live().find(s => s.assetId === id && validData(s.customData)); return allAssets().find(a => a.id === id) || (stored && { id, customData: stored.customData }); };
  function safeLink(value) {
    if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
    try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null; } catch (_) { return null; }
  }
  const sourceOf = a => a.customData || a.offlineData || a.objectURL || ("/web/stickers/" + a.path.replace(/^\/public\/stickers\//, ""));
  const defaultStrokeColor = () => document.documentElement.dataset.theme === "dark" ? "#d9d9d9" : "#000000";
  const textColor = s => /^#[0-9a-f]{6}$/i.test(s.textColor || "") ? s.textColor : defaultStrokeColor();
  const textSize = s => Number.isFinite(s.textSize) && s.textSize >= 10 && s.textSize <= 72 ? s.textSize : 16;
  const textBold = s => s.textBold === true;
  const textHtml = text => PR.md ? PR.md(text || "", { cite:false, xref:false, footnotePage:"" }) : esc(text || "").replace(/\n/g, "<br>");
  const styledSources = new Map();
  function stickerSource(asset, sticker) {
    if (asset.source !== "Lucide" || !asset.svgText) return sourceOf(asset);
    const color = sticker.strokeColor || defaultStrokeColor(), width = sticker.strokeWidth ?? 2;
    const key = asset.id + ":" + color + ":" + width;
    if (!styledSources.has(key)) {
      const svg = PR.stickerStyle.lucideSvg(asset.svgText, color, width);
      if (!svg) return sourceOf(asset);
      if (styledSources.size >= 64) styledSources.delete(styledSources.keys().next().value);
      styledSources.set(key, "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
    }
    return styledSources.get(key);
  }
  const live = () => Object.values(PR.state.reader.stickers || {}).filter(s => !s.deleted);
  const copy = x => x ? JSON.parse(JSON.stringify(x)) : null;
  const current = () => live().find(s => s.id === selected);
  const selectedItems = () => live().filter(s => selectedIds.has(s.id));
  const liveInk = () => Object.values(PR.state.reader.ink || {}).filter(stroke => !stroke.deleted);
  const selectedStrokes = () => liveInk().filter(stroke => selectedInkIds.has(stroke.id));
  const selectionCount = () => selectedItems().length + selectedStrokes().length;
  PR.isInkSelected = id => selectedInkIds.has(id);
  function setSelection(ids, primary, inkIds=[]) {
    selectedIds = new Set(ids.filter(Boolean));
    selectedInkIds = new Set(inkIds.filter(Boolean));
    selected = selectedIds.has(primary) ? primary : [...selectedIds][0] || null;
  }
  const clearSelection = () => setSelection([], null);
  function selectItem(item) {
    const items = item?.groupId ? live().filter(s => s.groupId === item.groupId) : [item];
    const ink = item?.groupId ? liveInk().filter(stroke => stroke.groupId === item.groupId) : [];
    setSelection(items.filter(Boolean).map(s => s.id), item?.id, ink.map(stroke => stroke.id));
  }
  function selectStroke(id) {
    const stroke=liveInk().find(item=>item.id===id), items=stroke?.groupId ? live().filter(item=>item.groupId===stroke.groupId) : [];
    const ink=stroke?.groupId ? liveInk().filter(item=>item.groupId===stroke.groupId) : [stroke];
    setSelection(items.map(item=>item.id),items[0]?.id,ink.filter(Boolean).map(item=>item.id));
  }
  const el = (tag, attrs) => { const x = document.createElementNS(ns, tag); for (const [k,v] of Object.entries(attrs)) x.setAttribute(k, String(v)); return x; };
  function validateSvg(s) {
    if (/<!doctype|<!entity|<\?xml-stylesheet|@import|url\s*\(/i.test(s)) return false;
    const doc = new DOMParser().parseFromString(s, "image/svg+xml");
    if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") return false;
    const allowed = new Set(["svg", "g", "defs", "style", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "title", "desc"]);
    return [...doc.querySelectorAll("*")].every(n => allowed.has(n.localName) &&
      (n.localName !== "style" || /^(?:\s*\.[a-zA-Z0-9_-]+\s*\{\s*fill\s*:\s*#[0-9a-fA-F]{3,8}\s*;?\s*\}\s*)*$/.test(n.textContent)) &&
      [...n.attributes].every(a => !/^on/i.test(a.name) && !/href$/i.test(a.name) && !/url\s*\(|javascript:|data:/i.test(a.value)));
  }
  function validData(value) {
    if (typeof value !== "string" || value.length > 540000) return false;
    const match = /^data:(image\/(?:png|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!match) return false;
    try {
      const raw = atob(match[2]);
      if (!raw.length || raw.length > 400000) return false;
      if (match[1] === "image/svg+xml") return validateSvg(new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0))));
      return match[1] === "image/png" ? raw.slice(0,8) === "\x89PNG\r\n\x1a\n" : raw.slice(0,4) === "RIFF" && raw.slice(8,12) === "WEBP";
    } catch (_) { return false; }
  }
  async function loadCatalog() {
    const embedded=document.getElementById("pr-data");
    if (embedded) {
      const saved=JSON.parse(embedded.textContent);
      assets=(saved.stickerAssets || []).filter(a => a && validData(a.offlineData));
      for (const a of assets) if (a.source === "Lucide" && a.format === "svg") a.svgText = new TextDecoder().decode(Uint8Array.from(atob(a.offlineData.split(",")[1]), c => c.charCodeAt(0)));
      offlineLicenses=saved.stickerLicenses || {};
      renderPanel(); PR.renderInk(); return;
    }
    const response = await fetch("/web/stickers/sticker-manifest.json");
    if (!response.ok) throw Error("catalog");
    const m = await response.json(), seen = new Set();
    assets = m.assets.filter(a => {
      if (!a || !/^[a-z0-9-]+$/.test(a.id) || seen.has(a.id) || !/^\/public\/stickers\/[a-z-]+\/[a-z0-9-]+\.(svg|png|webp)$/.test(a.path) || a.path.split("/")[3] !== a.category || !["svg","png","webp"].includes(a.format) || !a.path.endsWith("."+a.format)) return false;
      seen.add(a.id); return true;
    });
    const checked = await Promise.all(assets.map(async a => {
      try {
        const r = await fetch(sourceOf(a)); if (!r.ok) return null;
        const bytes = await r.arrayBuffer();
        if (a.sha256 && crypto.subtle) {
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(x => x.toString(16).padStart(2, "0")).join("");
          if (hash !== a.sha256) return null;
        }
        if (a.format === "svg") {
          const svgText = new TextDecoder().decode(bytes);
          if (!validateSvg(svgText)) return null;
          if (a.source === "Lucide") a.svgText = svgText;
        }
        const sig = new Uint8Array(bytes);
        if (a.format === "png" && !(sig[0] === 137 && sig[1] === 80 && sig[2] === 78 && sig[3] === 71)) return null;
        if (a.format === "webp" && !(String.fromCharCode(...sig.slice(0,4)) === "RIFF" && String.fromCharCode(...sig.slice(8,12)) === "WEBP")) return null;
        a.objectURL = URL.createObjectURL(new Blob([bytes], { type: { svg:"image/svg+xml", png:"image/png", webp:"image/webp" }[a.format] }));
        return a;
      } catch (_) { return null; }
    }));
    assets = checked.filter(Boolean); renderPanel(); PR.renderInk();
  }
  const labels = {
    k0: PR.t("貼紙素材庫"),
    k1: PR.t("關閉"),
    k2: PR.t("貼紙篩選"),
    k3: PR.t("全部貼紙"),
    k4: PR.t("最近使用"),
    k5: PR.t("收藏"),
    k6: PR.t("我的貼紙"),
    k7: PR.t("搜尋"),
    k8: PR.t("分類"),
    k9: PR.t("全部分類"),
    k10: PR.t("找不到貼紙"),
    k11: PR.t("加入自己的貼紙"),
    k12: PR.t("插入"),
    k13: PR.t("選擇貼紙以預覽"),
    k14: PR.t("素材來源與授權"),
    k15: PR.t("複製"),
    k17: PR.t("角度"),
    k19: PR.t("解除鎖定"),
    k20: PR.t("鎖定"),
    k21: PR.t("移至最上層"),
    k22: PR.t("上移一層"),
    k23: PR.t("下移一層"),
    k24: PR.t("移至最下層"),
    k25: PR.t("刪除"),
    k28: PR.t("自訂素材庫只儲存在目前瀏覽器；已插入的自訂貼紙會隨論文註記保存。"),
    k29: PR.t("未修改"),
    k30: PR.t("搜尋貼紙標籤…"),
    k31: PR.t("線條顏色"),
    k32: PR.t("線條粗細"),
    k33: PR.t("更多操作"),
    k34: PR.t("學術"),
    k35: PR.t("重點"),
    k36: PR.t("問題"),
    k37: PR.t("注意"),
    k38: PR.t("科學"),
    k39: PR.t("數學"),
    k40: PR.t("機器學習"),
    k41: PR.t("箭頭"),
    k42: PR.t("形狀"),
    k43: PR.t("便條"),
    k44: PR.t("裝飾"),
    k45: PR.t("方向鍵移動，Shift 加方向鍵縮放，Alt 加左右方向鍵旋轉"),
    k46: PR.t("群組"),
    k47: PR.t("解除群組"),
  };
  function previewHtml(chosen) {
    if (!chosen) return `<span class="sticker-preview-empty">${labels.k13}</span>`;
    const sourceLink = (chosen.source_url || "").startsWith("https://github.com/")
      ? '<a href="' + esc(chosen.source_url) + '" target="_blank" rel="noopener">' + labels.k14 + '</a>' : "";
    const licenseHtml = offlineLicenses ? '<pre>' + esc(Object.values(offlineLicenses).join("\n\n")) + '</pre>'
      : '<a href="/web/stickers/LICENSE-LUCIDE.txt" target="_blank" rel="noopener">Lucide / Feather</a> | <a href="/web/stickers/LICENSE-CC-BY-SA-4.0.txt" target="_blank" rel="noopener">Maria Letta - CC BY-SA 4.0</a>';
    return `<img src="${esc(sourceOf(chosen))}" data-source="${esc(chosen.source || "")}" alt=""><span class="sticker-preview-meta"><strong>${esc(chosen.name)}</strong><small>${esc(chosen.creator || "")} ${esc((chosen.license_ids || []).join(", "))} ${chosen.modified === false ? labels.k29 : ""} ${sourceLink}</small></span><details class="sticker-credit"><summary aria-label="${labels.k14}" title="${labels.k14}">${PR.icon("question","sm")}</summary><div class="sticker-license">${licenseHtml}</div></details><button type="button" class="sticker-favorite" data-favorite aria-label="${labels.k5}" aria-pressed="${settings.favorites.includes(chosen.id)}" title="${labels.k5}">${PR.icon("star","sm")}</button><button type="button" class="sticker-insert" data-insert>${labels.k12}</button>`;
  }
  function renderPanel() {
    if (panel.hidden) return;
    const gridEl = panel.querySelector(".sticker-grid");
    const prevScrollTop = gridEl ? gridEl.scrollTop : 0;
    const categoryNames = { academic:labels.k34, important:labels.k35, question:labels.k36, warning:labels.k37, science:labels.k38, mathematics:labels.k39, "machine-learning":labels.k40, arrows:labels.k41, shapes:labels.k42, "sticky-notes":labels.k43, decorative:labels.k44 };
    const categories = [...new Set(assets.map(a => a.category))].sort();
    const list = assets.filter(a => (!category || a.category === category) &&
      (filter === "all" || (filter === "favorites" && settings.favorites.includes(a.id)) || (filter === "recent" && settings.recent.includes(a.id))) &&
      (a.name + " " + (categoryNames[a.category] || a.category) + " " + (a.tags || []).join(" ")).toLowerCase().includes(query.toLowerCase()));
    if (filter === "recent") list.sort((a,b) => settings.recent.indexOf(a.id) - settings.recent.indexOf(b.id));
    const chosen = assetOf(preview);
    panel.innerHTML = `<header><strong>${labels.k0}</strong><button type="button" class="sticker-close" data-close aria-label="${labels.k1}" title="${labels.k1}">×</button></header>
      <div class="sticker-layout"><nav aria-label="${labels.k2}">${[["all",labels.k3],["recent",labels.k4],["favorites",labels.k5]].map(([id,label]) => `<button type="button" data-filter="${id}" aria-pressed="${filter===id}">${label}</button>`).join("")}</nav>
      <div class="sticker-content"><div class="sticker-search"><span aria-hidden="true">${PR.icon("search","sm")}</span><input data-search type="search" aria-label="${labels.k7}" placeholder="${labels.k30}" value="${esc(query)}"><details class="sticker-category"><summary aria-label="${labels.k8}: ${esc(categoryNames[category] || labels.k9)}">${esc(categoryNames[category] || labels.k9)} ${PR.icon("chevron","sm")}</summary><div class="sticker-category-list"><button type="button" data-category-value="" aria-pressed="${!category}">${labels.k9}</button>${categories.map(c=>`<button type="button" data-category-value="${esc(c)}" aria-pressed="${c===category}">${esc(categoryNames[c] || c)}</button>`).join("")}</div></details></div>
      <div class="sticker-grid">${list.map(a=>`<button type="button" draggable="true" data-asset="${esc(a.id)}" aria-label="${esc(a.name)}" title="${esc(a.name)}" aria-pressed="${preview===a.id}"><img src="${esc(sourceOf(a))}" data-source="${esc(a.source || "")}" alt=""></button>`).join("") || `<p>${labels.k10}</p>`}</div>
      <div class="sticker-preview">${previewHtml(chosen)}</div></div></div>`;
    const newGrid = panel.querySelector(".sticker-grid");
    if (newGrid && prevScrollTop > 0) newGrid.scrollTop = prevScrollTop;
  }
  function setMode(on) {
    if (!on && gesture) finishGesture(true);
    if (on && document.getElementById("inkToggle").getAttribute("aria-pressed") !== "true") PR.toggleInk();
    if (on && layer.classList.contains("erase")) PR.setInkEraser?.(false);
    PR.stickerMode = on;
    layer.classList.toggle("sticker-mode", on);
    if (!on) { PR.lassoMode=false; lasso=null; clearSelection(); bar.hidden = true; document.querySelector("[data-ink-lasso]")?.setAttribute("aria-pressed","false"); }
    PR.renderInk();
  }
  PR.setStickerMode = setMode;
  PR.closeStickerPanel = function () {
    if (panel && !panel.hidden) {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
  };
  PR.toggleStickerPanel = function () {
    if (!panel) return;
    if (panel.hidden) {
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      PR.setLassoMode && PR.setLassoMode(false);
      setMode(true);
      renderPanel();
    } else {
      PR.closeStickerPanel();
    }
  };
  PR.setLassoMode = on => {
    if (on) setMode(true);
    PR.lassoMode=!!on; if (!on) lasso=null;
    layer.classList.toggle("lasso-mode",!!on);
    document.querySelector("[data-ink-lasso]")?.setAttribute("aria-pressed",String(!!on));
    PR.renderInk();
  };
  document.getElementById("inkToggle").addEventListener("click", () => { if (document.getElementById("inkToggle").getAttribute("aria-pressed") !== "true") { setMode(false); PR.closeStickerPanel(); } });
  toggle.addEventListener("click", () => { PR.toggleStickerPanel(); });
  panel.addEventListener("dblclick", e => {
    const b = e.target.closest("[data-asset]");
    if (b && b.dataset.asset) {
      e.preventDefault();
      preview = b.dataset.asset;
      insert(b.dataset.asset);
    }
  });
  panel.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.hasAttribute("data-close")) { panel.hidden = true; toggle.setAttribute("aria-expanded", "false"); toggle.focus(); }
    if (b.dataset.filter) { filter = b.dataset.filter; category = ""; renderPanel(); }
    if (b.hasAttribute("data-category-value")) { category = b.dataset.categoryValue; renderPanel(); panel.querySelector(".sticker-category summary")?.focus(); return; }
    if (b.dataset.asset) {
      preview = b.dataset.asset;
      const previewEl = panel.querySelector(".sticker-preview");
      if (previewEl) {
        panel.querySelectorAll(".sticker-grid button").forEach(btn => {
          btn.setAttribute("aria-pressed", String(btn.dataset.asset === preview));
        });
        previewEl.innerHTML = previewHtml(assetOf(preview));
      } else {
        renderPanel();
      }
    }
    if (b.hasAttribute("data-favorite") && preview) { const previous=settings.favorites; settings.favorites = previous.includes(preview) ? previous.filter(x => x !== preview) : [...previous, preview]; if (!saveSettings()) settings.favorites=previous; renderPanel(); panel.querySelector("[data-favorite]")?.focus(); }
    if (b.hasAttribute("data-insert")) insert(preview);
  });
  panel.addEventListener("input", e => { if (e.target.matches("[data-search]")) { const pos=e.target.selectionStart; query=e.target.value; renderPanel(); const field=panel.querySelector("[data-search]"); field.focus(); field.setSelectionRange(pos,pos); } });
  panel.addEventListener("keydown", e => {
    const dropdown = e.target.closest(".sticker-category");
    if (!dropdown || !dropdown.open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dropdown.open = false; dropdown.querySelector("summary").focus(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault(); const options = [...dropdown.querySelectorAll("[data-category-value]")];
    const index = options.indexOf(document.activeElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : e.key === "ArrowDown" ? (index + 1) % options.length : (index <= 0 ? options.length - 1 : index - 1);
    options[next]?.focus();
  });
  document.addEventListener("pointerdown", e => {
    const dropdown = panel.querySelector(".sticker-category[open]");
    if (dropdown && !dropdown.contains(e.target)) dropdown.open = false;
    if (!panel.hidden && !e.target.closest("#stickerPanel, #stickerToggle")) {
      PR.closeStickerPanel();
    }
  });
  panel.addEventListener("dragstart", e => { const b=e.target.closest("[data-asset]"); if (b) e.dataTransfer.setData("application/x-paperread-sticker", b.dataset.asset); });
  let touchDrag = null;
  panel.addEventListener("pointerdown", e => {
    const button=e.target.closest("[data-asset]");
    if (button && e.pointerType !== "mouse") { touchDrag={ id:button.dataset.asset, pointer:e.pointerId, x:e.clientX, y:e.clientY }; button.setPointerCapture(e.pointerId); }
  });
  window.addEventListener("pointerup", e => {
    if (!touchDrag || e.pointerId !== touchDrag.pointer) return;
    const item=touchDrag; touchDrag=null;
    if (Math.hypot(e.clientX-item.x,e.clientY-item.y)<20) return;
    const target=document.elementFromPoint(e.clientX,e.clientY);
    if (target?.closest("#stage")) { e.preventDefault(); insert(item.id,e.clientX,e.clientY); }
  });
  window.addEventListener("pointercancel", () => { touchDrag=null; });
  const stage = document.getElementById("stage");
  stage.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("application/x-paperread-sticker")) e.preventDefault(); });
  stage.addEventListener("drop", e => { const id=e.dataTransfer.getData("application/x-paperread-sticker"); if (id) { e.preventDefault(); insert(id, e.clientX, e.clientY); } });
  function nearest(y) {
    return PR.$$("#paper > .blk[data-id]").reduce((best,b) => { const r=b.getBoundingClientRect(), d=Math.max(r.top-y,0,y-r.bottom); return !best || d<best.d ? { b,d } : best; },null)?.b;
  }
  function update(before, after) {
    if (after) after = { ...after, x:Math.max(-5000,Math.min(5000,after.x)), y:Math.max(-5000,Math.min(5000,after.y)), rotation:Math.max(-36000,Math.min(36000,after.rotation)), z:Math.max(-1000000,Math.min(1000000,after.z)) };
    if (after) PR.commit({ op:"sticker", sticker:after }); else PR.commit({ op:"sticker_del", id:before.id });
    PR.recordStickerHistory((after || before).id, copy(before), copy(after)); PR.renderInk(); renderBar();
  }
  function updateMany(entries) {
    const changes=entries.filter(({before,after}) => JSON.stringify(before) !== JSON.stringify(after));
    if (!changes.length) return;
    for (const {before,after} of changes) {
      if (after) PR.commit({op:"sticker",sticker:after}); else PR.commit({op:"sticker_del",id:before.id});
    }
    PR.recordStickerBatchHistory?.(changes.map(({before,after})=>({id:(after||before).id,before:copy(before),after:copy(after)})));
    PR.renderInk(); renderBar();
  }
  function updateSelection(stickerEntries, inkEntries) {
    const stickers=stickerEntries.filter(({before,after})=>JSON.stringify(before)!==JSON.stringify(after));
    const ink=inkEntries.filter(({before,after})=>JSON.stringify(before)!==JSON.stringify(after));
    if (!stickers.length && !ink.length) return;
    for (const {before,after} of stickers) {
      if (after) PR.commit({op:"sticker",sticker:after}); else PR.commit({op:"sticker_del",id:before.id});
    }
    for (const {before,after} of ink) {
      if (after) PR.commit({op:"ink",stroke:after}); else PR.commit({op:"ink_del",id:before.id});
    }
    PR.recordSelectionHistory?.(stickers.map(({before,after})=>({id:(after||before).id,before:copy(before),after:copy(after)})),ink.map(({before,after})=>({id:(after||before).id,before:copy(before),after:copy(after)})));
    PR.renderInk(); renderBar();
  }
  function strokeMember(stroke) {
    const block=document.getElementById("b-"+stroke.anchor), r=block?.getBoundingClientRect(), scale=r?.width/stroke.ref?.[0];
    return r && Number.isFinite(scale) && scale>0 ? {before:copy(stroke),draft:copy(stroke),scale} : null;
  }
  const moveStroke=(stroke,dx,dy)=>({...stroke,points:stroke.points.map(([x,y])=>[x+dx,y+dy])});
  function insert(id, x, y) {
    const a=assetOf(id), b=nearest(y ?? window.innerHeight/2); if (!a || !b || innerWidth < 768) { PR.toast(PR.t("目前無法插入貼紙")); return; }
    setMode(true); const image=new Image();
    image.onload=() => {
      if (innerWidth < 768 || !b.isConnected) return;
      const r=b.getBoundingClientRect();
      const w=100, h=Math.max(20,Math.min(300,w*image.naturalHeight/image.naturalWidth));
      const s={ id:PR.uid("s"), assetId:a.id, anchor:b.dataset.id, textHash:PR.hashText(b.innerText || ""), ref:[r.width,r.height], x:(x ?? r.left+r.width/2)-r.left-w/2, y:(y ?? Math.max(r.top,Math.min(r.bottom,innerHeight/2)))-r.top-h/2, width:w, height:h, rotation:0, opacity:1, z:Math.max(0,...live().map(v=>v.z))+1, locked:false, ...(a.customData ? { customData:a.customData } : {}) };
      setSelection([s.id],s.id); update(null,s); settings.recent=[id,...settings.recent.filter(v=>v!==id)].slice(0,30); saveSettings(); renderPanel();
    }; image.onerror=() => PR.toast(PR.t("貼紙載入失敗")); image.src=sourceOf(a);
  }
  PR.insertInkText = (x, y) => {
    const b=nearest(y); if (!b) return;
    const r=b.getBoundingClientRect();
    if (!r.width || !r.height) return;
    setMode(true);
    const s={id:PR.uid("s"),assetId:"paperread-text-box",anchor:b.dataset.id,textHash:PR.hashText(b.innerText || ""),ref:[r.width,r.height],x:x-r.left,y:y-r.top,width:220,height:80,rotation:0,opacity:1,z:Math.max(0,...live().map(v=>v.z))+1,locked:false,text:"",textBold:false};
    setSelection([s.id],s.id); update(null,s); editText(s);
  };
  function editText(s) {
    const group=[...layer.querySelectorAll("[data-sticker]")].find(node=>node.dataset.sticker===s.id), content=group?.querySelector("[data-sticker-content]"), rect=content?.getBoundingClientRect();
    if (!rect || s.locked) return;
    const input=document.createElement("textarea"), matrix=content.getScreenCTM(), width=Number(content.getAttribute("width")), height=Number(content.getAttribute("height"));
    input.className="ink-text-editor"; input.setAttribute("aria-label",PR.t("編輯文字方塊")); input.maxLength=2000; input.value=s.text || "";
    if (matrix && width>0 && height>0) {
      input.style.left="0px"; input.style.top="0px"; input.style.width=width+"px"; input.style.height=height+"px"; input.style.fontSize=(textSize(s)*width/s.width)+"px"; input.style.color=textColor(s); input.style.fontWeight=textBold(s) ? "700" : "400";
      input.style.transformOrigin="0 0"; input.style.transform=`matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.e},${matrix.f})`;
    } else { input.style.left=rect.left+"px"; input.style.top=rect.top+"px"; input.style.width=rect.width+"px"; input.style.height=rect.height+"px"; }
    document.body.append(input); input.focus();
    let done=false;
    const onViewportChange=e=>{ if (e.target !== input) close(false); };
    const close=cancel => { if (done) return; done=true; window.removeEventListener?.("scroll",onViewportChange,true); window.removeEventListener?.("resize",onViewportChange); const value=input.value; input.remove(); const fresh=live().find(item=>item.id===s.id); if (!cancel && fresh && !fresh.locked && value!==fresh.text) update(fresh,{...fresh,text:value}); };
    window.addEventListener("scroll",onViewportChange,true); window.addEventListener("resize",onViewportChange);
    input.addEventListener("blur",()=>close(false));
    input.addEventListener("keydown",e=>{ if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close(true);} else if(e.key==="Enter" && (e.ctrlKey||e.metaKey)){e.preventDefault();close(false);} });
  }
  function transform(s, sr, host) {
    const b=document.getElementById("b-"+s.anchor); if (!b) return null;
    const r=b.getBoundingClientRect(), scale=r.width/s.ref[0];
    if (!r.width || !r.height || PR.hashText(b.innerText || "")!==s.textHash || !Number.isFinite(scale) || scale<=0) return null;
    return { x:r.left-sr.left+s.x*scale, y:r.top-sr.top+host.scrollTop+s.y*scale, scale };
  }
  PR.renderStickers = (svg,sr,host,phase) => {
    for (const s of live().sort((a,b)=>a.z-b.z)) {
      if (window.innerWidth<768 && s.assetId!=="paperread-text-box") continue;
      if ((s.z < 0) !== (phase === "back")) continue;
      const a=assetOf(s.assetId), p=transform(s,sr,host); if (!a || !p) continue;
      const w=s.width*p.scale,h=s.height*p.scale, g=el("g", { transform:`translate(${p.x} ${p.y}) rotate(${s.rotation} ${w/2} ${h/2})`,"data-sticker":s.id, tabindex: PR.stickerMode ? 0 : -1, role:"button", "aria-label":a.name || s.assetId, "aria-description":labels.k45 });
      if (a.source === "text") {
        g.setAttribute("data-text-object", "");
        g.append(el("rect",{x:0,y:0,width:w,height:h,fill:"transparent","pointer-events":"all"}));
        const box=el("foreignObject",{x:0,y:0,width:w,height:h,opacity:s.opacity,"data-sticker-content":""});
        const content=document.createElementNS("http://www.w3.org/1999/xhtml","div"); content.className="ink-text-content"; content.style.fontSize=(textSize(s)*p.scale)+"px"; content.style.color=textColor(s); content.style.fontWeight=textBold(s) ? "700" : "400"; content.innerHTML=textHtml(s.text); box.append(content); g.append(box);
      } else {
        const img=el("image", { href:stickerSource(a,s),x:0,y:0,width:w,height:h,opacity:s.opacity,preserveAspectRatio:"none","data-sticker-content":"" });
        const url=safeLink(s.href); if (url) { const link=el("a",{href:url,target:"_blank",rel:"noopener noreferrer","aria-label":PR.t("開啟超連結"),"data-sticker-link":""}); link.append(img); g.append(link); } else g.append(img);
      }
      if (selectedIds.has(s.id) && PR.stickerMode) {
        g.append(el("rect",{x:0,y:0,width:w,height:h,fill:"none",stroke:"#2878c8","stroke-width":2,"pointer-events":"none"}));
        if (!s.locked && selectedIds.size === 1) {
          const handles = [["nw",0,0],["ne",w,0],["sw",0,h],["se",w,h],["rotate",w/2,-24]];
          if (a.source === "Lucide" || a.source === "text") {
            g.append(el("line",{x1:0,y1:0,x2:w,y2:0,stroke:"transparent","stroke-width":10,"data-handle":"n"}));
            g.append(el("line",{x1:0,y1:h,x2:w,y2:h,stroke:"transparent","stroke-width":10,"data-handle":"s"}));
            g.append(el("line",{x1:0,y1:0,x2:0,y2:h,stroke:"transparent","stroke-width":10,"data-handle":"w"}));
            g.append(el("line",{x1:w,y1:0,x2:w,y2:h,stroke:"transparent","stroke-width":10,"data-handle":"e"}));
            handles.push(["n",w/2,0],["s",w/2,h],["w",0,h/2],["e",w,h/2]);
          }
          for (const [handle,x,y] of handles) g.append(el("circle",{cx:x,cy:y,r:handle==="rotate"?7:6,fill:"white",stroke:"#2878c8","stroke-width":2,"data-handle":handle}));
        }
      }
      svg.append(g);
    }
    if (phase === "front" && lasso) renderLasso();
    if (phase === "front") renderBar();
  };
  function renderBar() {
    const items=selectedItems(), ink=selectedStrokes(), s=current(), count=items.length+ink.length;
    if (!count || !PR.stickerMode || (innerWidth<768 && s?.assetId!=="paperread-text-box")) { bar.hidden=true; return; }
    if (count > 1 || !s) {
      const groupedItems=[...items,...ink], canGroup=count>1 && !items.some(item=>item.locked), grouped=canGroup && groupedItems.every(item=>item.groupId && item.groupId===groupedItems[0].groupId);
      bar.classList.toggle("text-selection",false); bar.hidden=false;
      const groupLabel=grouped?labels.k47:labels.k46;
      bar.innerHTML=`<span class="sticker-selection-count">${count}</span>${canGroup?`<button data-action="${grouped?"ungroup":"group"}" aria-label="${groupLabel}" title="${groupLabel}">${PR.icon("link","sm")}</button>`:""}<button data-action="duplicate" aria-label="${labels.k15}" title="${labels.k15}">${PR.icon("copy","sm")}</button><button data-action="delete" class="sticker-delete" aria-label="${labels.k25}" title="${labels.k25}">${PR.icon("trash","sm")}</button>`;
      positionBar(); return;
    }
    const detailsOpen=!!bar.querySelector("details")?.open;
    const asset=assetOf(s.assetId), lucide=asset?.source === "Lucide" && !!asset.svgText;
    bar.classList.toggle("text-selection",asset?.source === "text");
    const color=/^#[0-9a-f]{6}$/i.test(s.strokeColor || "") ? s.strokeColor : defaultStrokeColor();
    const strokeWidth=Number.isFinite(s.strokeWidth) && s.strokeWidth >= 1 && s.strokeWidth <= 4 ? s.strokeWidth : 2;
    bar.hidden=false;
    bar.innerHTML=`${lucide?`<label class="sticker-color" title="${labels.k31}"><input data-field="strokeColor" type="color" aria-label="${labels.k31}" value="${color}"></label><label class="sticker-stroke" title="${labels.k32}"><span aria-hidden="true">${PR.icon("marker","sm")}</span><input data-field="strokeWidth" type="range" aria-label="${labels.k32}" min="1" max="4" step="0.25" value="${strokeWidth}"></label>`:""}${asset?.source === "text" ? `<label class="sticker-color" title="${PR.t("文字顏色")}"><input data-field="textColor" type="color" aria-label="${PR.t("文字顏色")}" value="${textColor(s)}"></label><div class="sticker-font-size"><button type="button" data-action="text-size-down" aria-label="${PR.t("縮小文字")}" title="${PR.t("縮小文字")}">−</button><input data-field="textSize" type="number" inputmode="numeric" aria-label="${PR.t("文字大小")}" min="10" max="72" step="1" value="${textSize(s)}"><button type="button" data-action="text-size-up" aria-label="${PR.t("放大文字")}" title="${PR.t("放大文字")}">+</button></div><button class="sticker-bold" data-action="text-bold" aria-label="${PR.t("粗體")}" aria-pressed="${textBold(s)}" title="${PR.t("粗體")}">B</button><button data-action="edit-text" aria-label="${PR.t("編輯文字方塊")}" title="${PR.t("編輯文字方塊")}">${PR.icon("edit","sm")}</button>` : `<button data-action="link" aria-label="${PR.t("設定超連結")}" title="${PR.t("設定超連結")}">${PR.icon("link","sm")}</button>`}<button data-action="duplicate" aria-label="${labels.k15}" title="${labels.k15}">${PR.icon("copy","sm")}</button><button data-action="rotate" aria-label="${labels.k17} +90°" title="${labels.k17} +90°">${PR.icon("redo","sm")}</button><button data-action="lock" class="sticker-lock" aria-label="${s.locked?labels.k19:labels.k20}" title="${s.locked?labels.k19:labels.k20}">${s.locked?labels.k19:labels.k20}</button><button data-action="delete" class="sticker-delete" aria-label="${labels.k25}" title="${labels.k25}" ${s.locked?"disabled":""}>${PR.icon("trash","sm")}</button><details ${detailsOpen?"open":""}><summary aria-label="${labels.k33}" title="${labels.k33}">${PR.icon("more","sm")}</summary><div class="sticker-more">${s.href ? `<button data-action="unlink">${PR.t("移除超連結")}</button>` : ""}<button data-action="front">${labels.k21}</button><button data-action="forward">${labels.k22}</button><button data-action="backward">${labels.k23}</button><button data-action="back">${labels.k24}</button></div></details>`;
    if (s.locked) bar.querySelectorAll('input, button:not([data-action="lock"])').forEach(control => { control.disabled=true; });
    positionBar();
  }
  function positionBar() {
    if (bar.hidden) return;
    const boxes=[...layer.querySelectorAll("[data-sticker]")].filter(node=>selectedIds.has(node.dataset.sticker)).map(group=>(group.querySelector('[data-sticker-content]') || group.querySelector("image"))?.getBoundingClientRect()).filter(Boolean);
    boxes.push(...[...layer.querySelectorAll("path[data-stroke]")].filter(path=>selectedInkIds.has(path.dataset.stroke)).map(path=>path.getBoundingClientRect()));
    if (!boxes.length) { bar.hidden=true; return; }
    const rect={left:Math.min(...boxes.map(box=>box.left)),right:Math.max(...boxes.map(box=>box.right)),top:Math.min(...boxes.map(box=>box.top)),bottom:Math.max(...boxes.map(box=>box.bottom))}, size=bar.getBoundingClientRect();
    const point=PR.stickerGeometry.toolbarPosition(rect,size,{width:innerWidth,height:innerHeight});
    if (!point) { bar.style.visibility="hidden"; return; }
    bar.style.visibility=""; bar.style.left=point.left+"px"; bar.style.top=point.top+"px";
    bar.classList.toggle("sticker-menu-above", point.top + size.height + 300 > innerHeight);
  }
  function act(action) {
    const items=selectedItems(), ink=selectedStrokes(), s=current(); if (!items.length && !ink.length) return;
    if (action==="group") { const groupId=PR.uid("g"); if (items.length+ink.length>1 && !items.some(item=>item.locked)) updateSelection(items.map(before=>({before,after:{...before,groupId}})),ink.map(before=>({before,after:{...before,groupId}}))); return; }
    if (action==="ungroup") { if (!items.some(item=>item.locked)) updateSelection(items.map(before=>{const after={...before}; delete after.groupId; return {before,after};}),ink.map(before=>{const after={...before}; delete after.groupId; return {before,after};})); return; }
    if ((action==="delete" || action==="duplicate") && (ink.length || items.length>1)) {
      const editable=items.filter(item=>!item.locked), groups=new Map();
      if (action==="delete") {
        clearSelection();
        return updateSelection(editable.map(before=>({before,after:null})),ink.map(before=>({before,after:null})));
      }
      const copiedGroupId=groupId=>{ if (!groupId) return null; if (!groups.has(groupId)) groups.set(groupId,PR.uid("g")); return groups.get(groupId); };
      const stickerCopies=editable.map((item,index)=>{ const next={...item,id:PR.uid("s"),x:item.x+12,y:item.y+12,z:Math.max(0,...live().map(v=>v.z))+index+1}; delete next.updated; const groupId=copiedGroupId(item.groupId); if (groupId) next.groupId=groupId; return next; });
      const inkCopies=ink.map((stroke,index)=>{ const member=strokeMember(stroke), offset=12+index*4; if (!member) return null; const next={...moveStroke(stroke,offset/member.scale,offset/member.scale),id:PR.uid("ink"),group:PR.uid("ink")}, groupId=copiedGroupId(stroke.groupId); if (groupId) next.groupId=groupId; return next; }).filter(Boolean);
      setSelection(stickerCopies.map(item=>item.id),stickerCopies[0]?.id,inkCopies.map(stroke=>stroke.id));
      return updateSelection(stickerCopies.map(after=>({before:null,after})),inkCopies.map(after=>({before:null,after})));
    }
    if (!s) return;
    if (action==="lock") return update(s,{...s,locked:!s.locked});
    if (s.locked) return;
    if (action==="text-bold" && s.assetId==="paperread-text-box") return update(s,{...s,textBold:!textBold(s)});
    if ((action==="text-size-down" || action==="text-size-up") && s.assetId==="paperread-text-box") { const size=Math.max(10,Math.min(72,textSize(s)+(action==="text-size-up" ? 1 : -1))); if (size!==textSize(s)) { update(s,{...s,textSize:size}); bar.querySelector(`[data-action="${action}"]`)?.focus(); } return; }
    if (action==="edit-text") return editText(s);
    if (action==="link") return editLink(s);
    if (action==="unlink") { const next={...s}; delete next.href; return update(s,next); }
    if (action==="delete") { clearSelection(); return update(s,null); }
    if (action==="duplicate") { const n={...s,id:PR.uid("s"),x:s.x+12,y:s.y+12,z:Math.max(0,...live().map(v=>v.z))+1}; delete n.updated; setSelection([n.id],n.id); return update(null,n); }
    const sorted=[0,...live().filter(v=>v.id!==s.id).map(v=>v.z)].sort((a,b)=>a-b);
    if (action==="rotate") return update(s,{...s,rotation:s.rotation+90});
    if (action==="front") return update(s,{...s,z:(sorted.at(-1)??s.z)+1});
    if (action==="back") return update(s,{...s,z:(sorted[0]??s.z)-1});
    if (action==="forward") { const z=sorted.find(v=>v>s.z); if (z!==undefined) return update(s,{...s,z:z+0.001}); }
    if (action==="backward") { const z=sorted.filter(v=>v<s.z).at(-1); if (z!==undefined) return update(s,{...s,z:z-0.001}); }
  }
  async function editLink(s) {
    const value=await PR.promptText({title:PR.t("設定超連結"),body:PR.t("請輸入 http 或 https 網址"),value:s.href || "",max:2048,at:bar});
    const fresh=live().find(item=>item.id===s.id); if (!fresh || fresh.locked) return;
    if (value === null) return;
    const href=safeLink(value); if (!href) { PR.toast(PR.t("請輸入有效的 http 或 https 網址")); return; }
    if (href!==fresh.href) update(fresh,{...fresh,href});
  }
  bar.addEventListener("click",e=>{const b=e.target.closest("[data-action]"); if (b) act(b.dataset.action);});
  bar.addEventListener("change",e=>{const s=current(), f=e.target.dataset.field; if (!s || s.locked) return;
    const source=assetOf(s.assetId)?.source;
    const focused=document.activeElement === e.target;
    if (f==="strokeColor" && source === "Lucide" && /^#[0-9a-f]{6}$/i.test(e.target.value)) update(s,{...s,strokeColor:e.target.value});
    if (f==="strokeWidth" && source === "Lucide") { const value=Number(e.target.value); if (Number.isFinite(value)) update(s,{...s,strokeWidth:Math.max(1,Math.min(4,value))}); }
    if (f==="textColor" && source === "text" && /^#[0-9a-f]{6}$/i.test(e.target.value)) update(s,{...s,textColor:e.target.value});
    if (f==="textSize" && source === "text") { const value=Number(e.target.value); if (e.target.value.trim() && Number.isFinite(value)) { const size=Math.max(10,Math.min(72,value)); if (size!==textSize(s)) update(s,{...s,textSize:size}); else renderBar(); } else renderBar(); }
    if (focused && (f==="strokeColor" || f==="strokeWidth" || f==="textColor" || f==="textSize")) bar.querySelector(`[data-field="${f}"]`)?.focus({preventScroll:true});
  });
  function lassoPoint(e) {
    const sr=stage.getBoundingClientRect();
    return {screen:{x:e.clientX,y:e.clientY},svg:{x:e.clientX-sr.left,y:e.clientY-sr.top+stage.scrollTop}};
  }
  function renderLasso() {
    if (!lasso?.svg.length) return;
    const path=el("polygon",{points:lasso.svg.map(point=>`${point.x},${point.y}`).join(" "),fill:"#2878c81a",stroke:"#2878c8","stroke-width":2,"stroke-dasharray":"5 4","pointer-events":"none"});
    path.setAttribute("data-lasso",""); layer.append(path);
  }
  function finishLasso(cancel) {
    if (!lasso) return;
    const value=lasso; lasso=null;
    if (!cancel && value.screen.length > 2) {
      const choices=[...layer.querySelectorAll("[data-sticker]")].map(node=>({id:node.dataset.sticker,rect:node.getBoundingClientRect()}));
      const hit=PR.stickerLasso.hits(value.screen,choices).map(item=>item.id);
      const ink=[...layer.querySelectorAll("path[data-stroke]")].filter(path=>PR.stickerLasso.hitsPath(value.screen,path)).map(path=>path.dataset.stroke);
      setSelection(hit,hit[0],ink);
    }
    PR.setLassoMode(false);
  }
  layer.addEventListener("pointerdown",e=>{
    if (!PR.stickerMode || e.button!==0) return;
    if (PR.lassoMode) { e.preventDefault(); e.stopPropagation(); const point=lassoPoint(e); lasso={pointer:e.pointerId,screen:[point.screen],svg:[point.svg]}; layer.setPointerCapture(e.pointerId); PR.renderInk(); return; }
    const group=e.target.closest("[data-sticker]"), path=!group && e.target.closest("path[data-stroke]");
    if (!group && !path) { clearSelection(); PR.renderInk(); return; }
    if (group && innerWidth<768 && live().find(item=>item.id===group.dataset.sticker)?.assetId!=="paperread-text-box") return;
    e.preventDefault(); e.stopPropagation();
    if (group) {
      const hit=live().find(item=>item.id===group.dataset.sticker);
      if (hit?.groupId || !selectedIds.has(hit?.id) || selectionCount()<=1) selectItem(hit);
    } else {
      const stroke=liveInk().find(item=>item.id===path.dataset.stroke);
      if (stroke?.groupId || !selectedInkIds.has(path.dataset.stroke) || selectionCount()<=1) selectStroke(path.dataset.stroke);
    }
    const s=current(), handle=group ? e.target.dataset.handle || "move" : "move";
    if (s?.locked && handle!=="move") { PR.renderInk(); return; }
    const targets=handle==="move" ? selectedItems().filter(item=>!item.locked) : s ? [s] : [];
    const members=targets.map(item=>{const block=document.getElementById("b-"+item.anchor),r=block?.getBoundingClientRect(),scale=r?.width/item.ref[0]; return r && Number.isFinite(scale) && scale>0 ? {before:copy(item),draft:copy(item),scale,r} : null;}).filter(Boolean);
    const inkMembers=handle==="move" ? selectedStrokes().map(strokeMember).filter(Boolean) : [];
    if (!members.length && !inkMembers.length) return;
    const primary=members[0];
    gesture={members,inkMembers,handle,startX:e.clientX,startY:e.clientY,cx:primary&&s ? primary.r.left+(s.x+s.width/2)*primary.scale : 0,cy:primary&&s ? primary.r.top+(s.y+s.height/2)*primary.scale : 0};
    layer.setPointerCapture(e.pointerId); PR.renderInk();
  });
  layer.addEventListener("pointermove",e=>{
    if (lasso && e.pointerId===lasso.pointer) { const point=lassoPoint(e), last=lasso.screen.at(-1); if (!last || Math.hypot(point.screen.x-last.x,point.screen.y-last.y)>=3) { lasso.screen.push(point.screen); lasso.svg.push(point.svg); PR.renderInk(); } return; }
    if (!gesture) return; const g=gesture;
    for (const member of g.members) {
      const dx=(e.clientX-g.startX)/member.scale,dy=(e.clientY-g.startY)/member.scale;
      if (g.handle==="move") member.draft=PR.stickerGeometry.move(member.before,dx,dy);
      else if (g.handle==="rotate") member.draft=PR.stickerGeometry.rotate(member.before,{x:g.startX,y:g.startY},{x:e.clientX,y:e.clientY},{x:g.cx,y:g.cy});
      else member.draft=PR.stickerGeometry.resize(member.before,g.handle,dx,dy,member.before.assetId==="paperread-text-box" || e.shiftKey);
      PR.state.reader.stickers[member.before.id]=member.draft;
    }
    for (const member of g.inkMembers) {
      const dx=(e.clientX-g.startX)/member.scale,dy=(e.clientY-g.startY)/member.scale;
      member.draft=moveStroke(member.before,dx,dy);
      PR.state.reader.ink[member.before.id]=member.draft;
    }
    PR.renderInk();
  });
  function finishGesture(cancel) { if (!gesture) return; const g=gesture; gesture=null; for (const member of g.members) PR.state.reader.stickers[member.before.id]=member.before; for (const member of g.inkMembers) PR.state.reader.ink[member.before.id]=member.before; if (!cancel && g.inkMembers.length) updateSelection(g.members.map(member=>({before:member.before,after:member.draft})),g.inkMembers.map(member=>({before:member.before,after:member.draft}))); else if (!cancel) updateMany(g.members.map(member=>({before:member.before,after:member.draft}))); else PR.renderInk(); }
  layer.addEventListener("pointerup",e=>{finishLasso(false);finishGesture(false);}); layer.addEventListener("pointercancel",()=>{finishLasso(true);finishGesture(true);});
  layer.addEventListener("click",e=>{ if (PR.stickerMode && e.target.closest?.("a[data-sticker-link]")) e.preventDefault(); });
  layer.addEventListener("dblclick",e=>{ const group=e.target.closest?.("[data-sticker]"); const s=group && live().find(item=>item.id===group.dataset.sticker); if (PR.stickerMode && !PR.lassoMode && s?.assetId==="paperread-text-box" && !s.locked) { e.preventDefault(); selectItem(s); editText(s); } });
  layer.addEventListener("contextmenu",e=>{
    const group=e.target.closest("[data-sticker]"), path=!group && e.target.closest("path[data-stroke]");
    if (!PR.stickerMode || (!group && !path)) return;
    e.preventDefault(); if (group) selectItem(live().find(item=>item.id===group.dataset.sticker)); else selectStroke(path.dataset.stroke); PR.renderInk();
    document.getElementById("stickerContext")?.remove();
    const menu=document.createElement("div"), button=document.createElement("button");
    menu.id="stickerContext"; menu.setAttribute("role","menu"); button.type="button"; button.setAttribute("role","menuitem");
    button.textContent=PR.t("刪除"); button.disabled=!!current()?.locked; button.addEventListener("click",()=>{act("delete");menu.remove();});
    menu.append(button); document.body.append(menu);
    menu.style.left=Math.max(0,Math.min(e.clientX,innerWidth-menu.offsetWidth)) + "px";
    menu.style.top=Math.max(0,Math.min(e.clientY,innerHeight-menu.offsetHeight)) + "px";
    button.focus();
  });
  document.addEventListener("pointerdown",e=>{ if (!e.target.closest?.("#stickerContext")) document.getElementById("stickerContext")?.remove(); });
  document.addEventListener("keydown",e=>{
    if (!PR.stickerMode || e.target.closest?.("input,textarea,select,[contenteditable]")) return;
    const target=e.target.closest?.("[data-sticker]");
    if (target && (e.key==="Enter" || e.key===" ")) { e.preventDefault(); selectItem(live().find(item=>item.id===target.dataset.sticker)); PR.renderInk(); bar.querySelector("button")?.focus(); return; }
    const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if (target && arrows[e.key] && !e.ctrlKey && !e.metaKey) {
      selectItem(live().find(item=>item.id===target.dataset.sticker)); const s=current(); if (!s || s.locked) return;
      const [dx,dy]=arrows[e.key]; if (e.altKey && !dx) return;
      e.preventDefault();
      const items=selectedItems().filter(item=>!item.locked);
      if (items.length>1 && !e.altKey && !e.shiftKey) { updateMany(items.map(item=>({before:item,after:PR.stickerGeometry.move(item,dx,dy)}))); [...layer.querySelectorAll("[data-sticker]")].find(node=>node.dataset.sticker===selected)?.focus(); return; }
      const next=e.altKey ? {...s,rotation:s.rotation+dx*15} : e.shiftKey ? PR.stickerGeometry.resize(s,"se",dx*4,dy*4,false) : PR.stickerGeometry.move(s,dx,dy);
      update(s,next); [...layer.querySelectorAll("[data-sticker]")].find(node=>node.dataset.sticker===selected)?.focus(); return;
    }
    if ((e.key==="Delete"||e.key==="Backspace") && selectionCount()) {e.preventDefault();act("delete");}
  });
  window.addEventListener("resize",()=>{ finishGesture(true); if (innerWidth<768) bar.hidden=true; PR.renderInk(); });
  window.addEventListener("scroll",positionBar,{passive:true});
  window.addEventListener("blur",()=>finishGesture(true));
  new MutationObserver(() => PR.renderInk()).observe(document.documentElement, { attributes:true, attributeFilter:["data-theme"] });
  PR.on("reader", op=>{if(op?.op==="sticker"||op?.op==="sticker_del") PR.renderInk();});
  PR.on("remote", changed=>{ if (gesture && (changed.includes("reader") || changed.includes("paper"))) { gesture=null; PR.renderInk(); PR.toast(PR.t("貼紙已在其他地方修改，無法復原")); } });
  loadCatalog().catch(()=>{panel.textContent=PR.t("貼紙素材庫載入失敗");});
})(window.PR);
