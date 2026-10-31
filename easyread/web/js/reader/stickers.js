/* Stickers share the paragraph-anchored ink layer and its local undo history. */
(function (PR) {
  "use strict";
  const panel = document.getElementById("stickerPanel"), toggle = document.getElementById("stickerToggle");
  const bar = document.getElementById("stickerTools"), layer = document.getElementById("inkLayer");
  const ns = "http://www.w3.org/2000/svg", esc = PR.esc;
  const storageKey = "paperread-sticker-library";
  let assets = [], preview = null, selected = null, gesture = null, offlineLicenses = null;
  let filter = "all", category = "", query = "", settings = PR.ls.get(storageKey, { favorites: [], recent: [], custom: [] });
  if (!settings || !Array.isArray(settings.favorites) || !Array.isArray(settings.recent) || !Array.isArray(settings.custom)) settings = { favorites: [], recent: [], custom: [] };
  const saveSettings = () => { const ok = PR.ls.set(storageKey, settings); if (!ok) PR.toast(PR.t("無法儲存貼紙偏好，瀏覽器儲存空間不足")); return ok; };
  const allAssets = () => [...assets, ...settings.custom.filter(a => a && /^custom-[a-z0-9]+$/.test(a.id) && validData(a.customData))];
  const assetOf = id => { const stored = live().find(s => s.assetId === id && validData(s.customData)); return allAssets().find(a => a.id === id) || (stored && { id, customData: stored.customData }); };
  const sourceOf = a => a.customData || a.offlineData || a.objectURL || ("/web/stickers/" + a.path.replace(/^\/public\/stickers\//, ""));
  const defaultStrokeColor = () => document.documentElement.dataset.theme === "dark" ? "#d9d9d9" : "#000000";
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
    if (on && layer.classList.contains("erase")) document.querySelector("[data-ink-erase]").click();
    PR.stickerMode = on;
    layer.classList.toggle("sticker-mode", on);
    if (!on) { selected = null; bar.hidden = true; }
    PR.renderInk();
  }
  PR.setStickerMode = setMode;
  document.getElementById("inkToggle").addEventListener("click", () => { if (document.getElementById("inkToggle").getAttribute("aria-pressed") !== "true") setMode(false); });
  toggle.addEventListener("click", () => { panel.hidden = !panel.hidden; toggle.setAttribute("aria-expanded", String(!panel.hidden)); if (!panel.hidden) { setMode(true); renderPanel(); } });
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
  document.addEventListener("pointerdown", e => { const dropdown=panel.querySelector(".sticker-category[open]"); if (dropdown && !dropdown.contains(e.target)) dropdown.open=false; });
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
  function insert(id, x, y) {
    const a=assetOf(id), b=nearest(y ?? window.innerHeight/2); if (!a || !b || innerWidth < 768) { PR.toast(PR.t("目前無法插入貼紙")); return; }
    setMode(true); const image=new Image();
    image.onload=() => {
      if (innerWidth < 768 || !b.isConnected) return;
      const r=b.getBoundingClientRect();
      const w=100, h=Math.max(20,Math.min(300,w*image.naturalHeight/image.naturalWidth));
      const s={ id:PR.uid("s"), assetId:a.id, anchor:b.dataset.id, textHash:PR.hashText(b.innerText || ""), ref:[r.width,r.height], x:(x ?? r.left+r.width/2)-r.left-w/2, y:(y ?? Math.max(r.top,Math.min(r.bottom,innerHeight/2)))-r.top-h/2, width:w, height:h, rotation:0, opacity:1, z:Math.max(0,...live().map(v=>v.z))+1, locked:false, ...(a.customData ? { customData:a.customData } : {}) };
      selected=s.id; update(null,s); settings.recent=[id,...settings.recent.filter(v=>v!==id)].slice(0,30); saveSettings(); renderPanel();
    }; image.onerror=() => PR.toast(PR.t("貼紙載入失敗")); image.src=sourceOf(a);
  }
  function transform(s, sr, host) {
    const b=document.getElementById("b-"+s.anchor); if (!b) return null;
    const r=b.getBoundingClientRect(), scale=r.width/s.ref[0];
    if (!r.width || !r.height || PR.hashText(b.innerText || "")!==s.textHash || !Number.isFinite(scale) || scale<=0) return null;
    return { x:r.left-sr.left+s.x*scale, y:r.top-sr.top+host.scrollTop+s.y*scale, scale };
  }
  PR.renderStickers = (svg,sr,host,phase) => {
    if (window.innerWidth<768) { bar.hidden=true; return; }
    for (const s of live().sort((a,b)=>a.z-b.z)) {
      if ((s.z < 0) !== (phase === "back")) continue;
      const a=assetOf(s.assetId), p=transform(s,sr,host); if (!a || !p) continue;
      const w=s.width*p.scale,h=s.height*p.scale, g=el("g", { transform:`translate(${p.x} ${p.y}) rotate(${s.rotation} ${w/2} ${h/2})`,"data-sticker":s.id, tabindex: PR.stickerMode ? 0 : -1, role:"button", "aria-label":a.name || s.assetId, "aria-description":labels.k45 });
      const img=el("image", { href:stickerSource(a,s),x:0,y:0,width:w,height:h,opacity:s.opacity,preserveAspectRatio:"none" }); g.append(img);
      if (s.id===selected && PR.stickerMode) {
        g.append(el("rect",{x:0,y:0,width:w,height:h,fill:"none",stroke:"#2878c8","stroke-width":2,"pointer-events":"none"}));
        if (!s.locked) {
          const handles = [["nw",0,0],["ne",w,0],["sw",0,h],["se",w,h],["rotate",w/2,-24]];
          if (a.source === "Lucide") {
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
    if (phase === "front") renderBar();
  };
  function renderBar() {
    const s=current(); if (!s || !PR.stickerMode || innerWidth<768) { bar.hidden=true; return; }
    const detailsOpen=!!bar.querySelector("details")?.open;
    const asset=assetOf(s.assetId), lucide=asset?.source === "Lucide" && !!asset.svgText;
    const color=/^#[0-9a-f]{6}$/i.test(s.strokeColor || "") ? s.strokeColor : defaultStrokeColor();
    const strokeWidth=Number.isFinite(s.strokeWidth) && s.strokeWidth >= 1 && s.strokeWidth <= 4 ? s.strokeWidth : 2;
    bar.hidden=false;
    bar.innerHTML=`${lucide?`<label class="sticker-color" title="${labels.k31}"><input data-field="strokeColor" type="color" aria-label="${labels.k31}" value="${color}"></label><label class="sticker-stroke" title="${labels.k32}"><span aria-hidden="true">${PR.icon("marker","sm")}</span><input data-field="strokeWidth" type="range" aria-label="${labels.k32}" min="1" max="4" step="0.25" value="${strokeWidth}"></label>`:""}<button data-action="duplicate" aria-label="${labels.k15}" title="${labels.k15}">${PR.icon("copy","sm")}</button><button data-action="rotate" aria-label="${labels.k17} +90°" title="${labels.k17} +90°">${PR.icon("redo","sm")}</button><button data-action="lock" class="sticker-lock" aria-label="${s.locked?labels.k19:labels.k20}" title="${s.locked?labels.k19:labels.k20}">${s.locked?labels.k19:labels.k20}</button><button data-action="delete" class="sticker-delete" aria-label="${labels.k25}" title="${labels.k25}" ${s.locked?"disabled":""}>${PR.icon("trash","sm")}</button><details ${detailsOpen?"open":""}><summary aria-label="${labels.k33}" title="${labels.k33}">${PR.icon("more","sm")}</summary><div class="sticker-more"><button data-action="front">${labels.k21}</button><button data-action="forward">${labels.k22}</button><button data-action="backward">${labels.k23}</button><button data-action="back">${labels.k24}</button></div></details>`;
    if (s.locked) bar.querySelectorAll('input, button:not([data-action="lock"])').forEach(control => { control.disabled=true; });
    positionBar();
  }
  function positionBar() {
    if (bar.hidden) return;
    const group = [...layer.querySelectorAll("[data-sticker]")].find(node => node.dataset.sticker === selected);
    const img = group?.querySelector("image");
    if (!img) { bar.hidden=true; return; }
    const rect=img.getBoundingClientRect(), size=bar.getBoundingClientRect();
    const point=PR.stickerGeometry.toolbarPosition(rect,size,{width:innerWidth,height:innerHeight});
    if (!point) { bar.style.visibility="hidden"; return; }
    bar.style.visibility=""; bar.style.left=point.left+"px"; bar.style.top=point.top+"px";
    bar.classList.toggle("sticker-menu-above", point.top + size.height + 300 > innerHeight);
  }
  function act(action) {
    const s=current(); if (!s) return;
    if (action==="lock") return update(s,{...s,locked:!s.locked});
    if (s.locked) return;
    if (action==="delete") { selected=null; return update(s,null); }
    if (action==="duplicate") { const n={...s,id:PR.uid("s"),x:s.x+12,y:s.y+12,z:Math.max(0,...live().map(v=>v.z))+1}; delete n.updated; selected=n.id; return update(null,n); }
    const sorted=[0,...live().filter(v=>v.id!==s.id).map(v=>v.z)].sort((a,b)=>a-b);
    if (action==="rotate") return update(s,{...s,rotation:s.rotation+90});
    if (action==="front") return update(s,{...s,z:(sorted.at(-1)??s.z)+1});
    if (action==="back") return update(s,{...s,z:(sorted[0]??s.z)-1});
    if (action==="forward") { const z=sorted.find(v=>v>s.z); if (z!==undefined) return update(s,{...s,z:z+0.001}); }
    if (action==="backward") { const z=sorted.filter(v=>v<s.z).at(-1); if (z!==undefined) return update(s,{...s,z:z-0.001}); }
  }
  bar.addEventListener("click",e=>{const b=e.target.closest("[data-action]"); if (b) act(b.dataset.action);});
  bar.addEventListener("change",e=>{const s=current(), f=e.target.dataset.field; if (!s || s.locked || assetOf(s.assetId)?.source !== "Lucide") return;
    const focused=document.activeElement === e.target;
    if (f==="strokeColor" && /^#[0-9a-f]{6}$/i.test(e.target.value)) update(s,{...s,strokeColor:e.target.value});
    if (f==="strokeWidth") { const value=Number(e.target.value); if (Number.isFinite(value)) update(s,{...s,strokeWidth:Math.max(1,Math.min(4,value))}); }
    if (focused && (f==="strokeColor" || f==="strokeWidth")) bar.querySelector(`[data-field="${f}"]`)?.focus({preventScroll:true});
  });
  layer.addEventListener("pointerdown",e=>{
    if (!PR.stickerMode || innerWidth<768 || e.button!==0) return;
    const group=e.target.closest("[data-sticker]"); if (!group) { selected=null; PR.renderInk(); return; }
    e.preventDefault(); e.stopPropagation(); selected=group.dataset.sticker; const s=current(); if (!s) return;
    if (s.locked) { PR.renderInk(); return; }
    const block=document.getElementById("b-"+s.anchor), r=block.getBoundingClientRect(), scale=r.width/s.ref[0];
    gesture={before:copy(s),draft:copy(s),handle:e.target.dataset.handle || "move", startX:e.clientX,startY:e.clientY, scale, cx:r.left+(s.x+s.width/2)*scale,cy:r.top+(s.y+s.height/2)*scale};
    layer.setPointerCapture(e.pointerId); PR.renderInk();
  });
  layer.addEventListener("pointermove",e=>{
    if (!gesture) return; const g=gesture,s=g.before, dx=(e.clientX-g.startX)/g.scale,dy=(e.clientY-g.startY)/g.scale;
    if (g.handle==="move") g.draft=PR.stickerGeometry.move(s,dx,dy);
    else if (g.handle==="rotate") g.draft=PR.stickerGeometry.rotate(s,{x:g.startX,y:g.startY},{x:e.clientX,y:e.clientY},{x:g.cx,y:g.cy});
    else g.draft=PR.stickerGeometry.resize(s,g.handle,dx,dy,e.shiftKey);
    PR.state.reader.stickers[s.id]=g.draft; PR.renderInk();
  });
  function finishGesture(cancel) { if (!gesture) return; const g=gesture; gesture=null; PR.state.reader.stickers[g.before.id]=g.before; if (!cancel && JSON.stringify(g.before)!==JSON.stringify(g.draft)) update(g.before,g.draft); else PR.renderInk(); }
  layer.addEventListener("pointerup",()=>finishGesture(false)); layer.addEventListener("pointercancel",()=>finishGesture(true));
  layer.addEventListener("contextmenu",e=>{
    if (!PR.stickerMode || !e.target.closest("[data-sticker]")) return;
    e.preventDefault(); selected=e.target.closest("[data-sticker]").dataset.sticker; PR.renderInk();
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
    if (target && (e.key==="Enter" || e.key===" ")) { e.preventDefault(); selected=target.dataset.sticker; PR.renderInk(); bar.querySelector("button")?.focus(); return; }
    const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if (target && arrows[e.key] && !e.ctrlKey && !e.metaKey) {
      selected=target.dataset.sticker; const s=current(); if (!s || s.locked) return;
      const [dx,dy]=arrows[e.key]; if (e.altKey && !dx) return;
      e.preventDefault();
      const next=e.altKey ? {...s,rotation:s.rotation+dx*15} : e.shiftKey ? PR.stickerGeometry.resize(s,"se",dx*4,dy*4,false) : PR.stickerGeometry.move(s,dx,dy);
      update(s,next); [...layer.querySelectorAll("[data-sticker]")].find(node=>node.dataset.sticker===selected)?.focus(); return;
    }
    if ((e.key==="Delete"||e.key==="Backspace") && current()) {e.preventDefault();act("delete");}
  });
  window.addEventListener("resize",()=>{ finishGesture(true); if (innerWidth<768) bar.hidden=true; PR.renderInk(); });
  window.addEventListener("scroll",positionBar,{passive:true});
  window.addEventListener("blur",()=>finishGesture(true));
  new MutationObserver(() => PR.renderInk()).observe(document.documentElement, { attributes:true, attributeFilter:["data-theme"] });
  PR.on("reader", op=>{if(op?.op==="sticker"||op?.op==="sticker_del") PR.renderInk();});
  PR.on("remote", changed=>{ if (gesture && (changed.includes("reader") || changed.includes("paper"))) { gesture=null; PR.renderInk(); PR.toast(PR.t("貼紙已在其他地方修改，無法復原")); } });
  loadCatalog().catch(()=>{panel.textContent=PR.t("貼紙素材庫載入失敗");});
})(window.PR);
