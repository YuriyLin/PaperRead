/* 论文笔记：Tiptap 官方工具栏与双向定位的 Markmap。 */
(function (PR) {
  "use strict";
  const panel = PR.$("#notespanel"), libraries = PR.noteLibraries;
  let rich = null, map = null, observer = null, richSource = "", formula = null, unmountToolbar = null;
  let mode = "rich", split = PR.ls.get("easyread-note-split", 58), firstMap = true;
  let mapBody = null, selectingFromMap = false;
  let mapVisible = PR.ls.get("easyread-note-map-visible", true);
  const workspace = () => panel.querySelector(".pn-workspace");
  const label = text => PR.esc(text);

  const ICON_EXPAND_ALL =
    '<svg class="i sm" viewBox="0 0 20 20" aria-hidden="true">' +
    '<circle cx="4" cy="10" r="2" fill="currentColor"/>' +
    '<circle cx="16" cy="4" r="1.5" fill="currentColor"/>' +
    '<circle cx="16" cy="10" r="1.5" fill="currentColor"/>' +
    '<circle cx="16" cy="16" r="1.5" fill="currentColor"/>' +
    '<path d="M6 10h4m0 0V4h4.5m-4.5 6v6h4.5m-4.5-6h4.5"/>' +
    '</svg>';

  const ICON_COLLAPSE_MAIN =
    '<svg class="i sm" viewBox="0 0 20 20" aria-hidden="true">' +
    '<circle cx="4" cy="10" r="2" fill="currentColor"/>' +
    '<circle cx="12" cy="5" r="1.5" fill="currentColor"/>' +
    '<circle cx="12" cy="15" r="1.5" fill="currentColor"/>' +
    '<path d="M6 10h3a1 1 0 0 0 1-1V5h1m-1 5a1 1 0 0 1 1 1v4h1"/>' +
    '<path d="M17 5h-3m3 10h-3"/>' +
    '</svg>';

  function setMode(next) {
    mode = next;
    const el = workspace(), body = PR.$("#paperNote").value;
    if (mode !== "source" && body !== richSource) {
      richSource = body;
      rich.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
    }
    el.querySelector(".pn-rich-pane").hidden = mode !== "rich";
    el.querySelector(".pn-format").hidden = mode !== "rich";
    el.querySelector(".pn-source").hidden = mode !== "source";
    el.querySelector(".pn-formula").hidden = true;
    el.querySelectorAll("[data-note-mode]").forEach(button => {
      button.classList.toggle("on", button.dataset.noteMode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.noteMode === mode));
    });
  }

  function setSplit(value) {
    split = Math.max(25, Math.min(80, value));
    workspace().style.setProperty("--note-split", split + "%");
    workspace().querySelector(".pn-divider").setAttribute("aria-valuenow", String(Math.round(split)));
  }

  function setMapVisible(visible) {
    mapVisible = visible;
    const el = workspace(), button = el.querySelector("[data-note-map-toggle]");
    el.classList.toggle("pn-map-hidden", !visible);
    el.querySelector(".pn-divider").hidden = !visible;
    el.querySelector(".pn-mindmap").hidden = !visible;
    button.setAttribute("aria-expanded", String(visible));
    button.setAttribute("aria-pressed", String(visible));
    button.classList.toggle("on", visible);
    const action = visible ? PR.t("隐藏思维导图") : PR.t("显示思维导图");
    button.title = action;
    button.setAttribute("aria-label", action);
    if (visible && map) updateMap();
  }

  function foldBranches(node, depth = 0) {
    if (!node) return;
    if (depth >= 1 && node.children && node.children.length > 0) {
      node.payload = { ...(node.payload || {}), fold: 1 };
    }
    for (const child of node.children || []) {
      foldBranches(child, depth + 1);
    }
  }

  function setFoldAll(node, fold) {
    if (!node) return;
    if (node.children && node.children.length > 0) {
      node.payload = { ...(node.payload || {}), fold: fold ? 1 : 0 };
    }
    for (const child of node.children || []) {
      setFoldAll(child, fold);
    }
  }

  function buildRootData(shouldFoldToMain = false) {
    const body = PR.$("#paperNote")?.value || "";
    const doc = body === richSource ? rich.getJSON() : rich.markdown.parse(body);
    const meta = PR.state.paper.meta || {};
    const root = libraries.toMindMap(doc, meta.short_zh || meta.title_zh || meta.title_en || PR.t("论文笔记"));
    if (shouldFoldToMain) foldBranches(root, 0);
    return {
      body,
      empty: !body.trim(),
      root,
    };
  }

  async function revealSelection() {
    if (!mapVisible || !map || !rich || !rich.isFocused || mode !== "rich" || selectingFromMap || PR.$("#paperNote").value !== mapBody) return;
    const current = map, match = libraries.findMapNode(current.state.data, rich.state.selection.from);
    if (!match) return;
    for (const ancestor of match.ancestors) if (ancestor.payload?.fold) await current.toggleNode(ancestor);
    if (current !== map) return;
    await current.setHighlight(match.node);
    if (current === map) await current.ensureVisible(match.node);
  }

  async function updateMap(forceFoldToMain = false) {
    if (!mapVisible || !rich || !map) return;
    const current = map;
    const isFirst = firstMap;
    const { body, empty, root } = buildRootData(forceFoldToMain || isFirst);
    const emptyHint = workspace()?.querySelector(".pn-map-empty");
    if (emptyHint) emptyHint.hidden = !empty;
    await current.setData(root);
    if (current !== map || !mapVisible) return;
    mapBody = body;
    if (isFirst && !empty) {
      firstMap = false;
      setTimeout(() => current.fit(1.0), 40);
    }
    if (empty) firstMap = true;
    if (rich.isFocused) revealSelection();
  }
  const updateSoon = PR.debounce(updateMap, 120);

  async function exportMap(targetMap = map, bgContainer = null) {
    updateSoon.cancel();
    if (targetMap === map) await updateMap();
    if (!targetMap) return;
    await document.fonts.ready;
    const svg = targetMap.svg.node(), copy = svg.cloneNode(true), fonts = new Set();
    const properties = "color display font-family font-size font-style font-weight line-height letter-spacing text-align text-decoration white-space vertical-align position top right bottom left width height min-width max-width box-sizing margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left border-top border-right border-bottom border-left border-radius background-color fill fill-opacity stroke stroke-width stroke-opacity stroke-dasharray stroke-linecap stroke-linejoin opacity overflow".split(" ");
    const originals = [svg, ...svg.querySelectorAll("*")], copies = [copy, ...copy.querySelectorAll("*")];
    originals.forEach((node, i) => {
      const style = getComputedStyle(node), target = copies[i];
      for (const property of properties) target.style.setProperty(property, style.getPropertyValue(property));
      if (node.namespaceURI === "http://www.w3.org/1999/xhtml") {
        target.style.transform = style.transform;
        target.style.transformOrigin = style.transformOrigin;
      }
      style.fontFamily.split(",").forEach(name => fonts.add(name.trim().replace(/["']/g, "")));
    });
    const fontRules = [];
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
      if (rule.type !== CSSRule.FONT_FACE_RULE || !fonts.has(rule.style.fontFamily.replace(/["']/g, ""))) continue;
      const source = rule.style.getPropertyValue("src").match(/url\((["']?)(.*?)\1\)/);
      if (!source) continue;
      const response = await fetch(new URL(source[2], sheet.href || document.baseURI));
      const blob = await response.blob();
      const data = await new Promise(resolve => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob);
      });
      fontRules.push('@font-face{font-family:' + rule.style.fontFamily + ';font-style:' + rule.style.fontStyle + ';font-weight:' + rule.style.fontWeight + ';src:url("' + data + '")}');
    }
    copy.querySelectorAll("style, .markmap-highlight").forEach(node => node.remove());
    const ns = "http://www.w3.org/2000/svg", group = copy.querySelector("g");
    group.removeAttribute("transform");
    const bounds = targetMap.g.node().getBBox(), padding = 20;
    const width = Math.ceil(bounds.width + padding * 2), height = Math.ceil(bounds.height + padding * 2);
    const x = bounds.x - padding, y = bounds.y - padding;
    copy.setAttribute("xmlns", ns);
    copy.setAttribute("viewBox", [x, y, width, height].join(" "));
    copy.setAttribute("width", width); copy.setAttribute("height", height);
    copy.style.width = width + "px"; copy.style.height = height + "px";
    if (fontRules.length) {
      const style = document.createElementNS(ns, "style"); style.textContent = fontRules.join("\n"); copy.prepend(style);
    }
    const hostEl = bgContainer || workspace()?.querySelector(".pn-mindmap") || document.body;
    const background = document.createElementNS(ns, "rect");
    for (const [key, value] of Object.entries({ x, y, width, height, fill: getComputedStyle(hostEl).backgroundColor })) background.setAttribute(key, value);
    copy.insertBefore(background, group);
    const meta = PR.state.paper.meta || {}, stem = (meta.short_zh || meta.title_zh || meta.title_en || PR.t("论文笔记")).replace(/[\\/:*?"<>|]/g, "");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml;charset=utf-8" }));
    const link = PR.el("a", { href: url, download: stem + PR.t("-思维导图.svg") });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function selectNote(node, targetMap = map) {
    const range = node.payload;
    if (range?.from == null) return;
    selectingFromMap = true;
    setMode("rich");
    const source = rich.state.doc.nodeAt(range.from);
    if (source?.isAtom || source?.type.name === "table") rich.chain().focus().setNodeSelection(range.from).scrollIntoView().run();
    else rich.chain().focus().setTextSelection({ from: range.from + 1, to: range.to - 1 }).scrollIntoView().run();
    selectingFromMap = false;
    targetMap?.setHighlight(node);
    if (targetMap !== map && map) map.setHighlight(node);
  }

  async function openMapModal() {
    if (!rich) return;
    const backdrop = PR.$("#mindmapDlg");
    const dialog = backdrop?.querySelector(".dialog");
    if (!backdrop || !dialog) return;
    const { empty, root } = buildRootData(true);
    const meta = PR.state.paper.meta || {};
    const title = meta.title_zh || meta.title_en || PR.t("论文笔记");
    const titleDisp = PR.titleHtml ? PR.titleHtml(title) : PR.esc(title);
    const isDark = () => document.documentElement.dataset.theme === "dark";

    dialog.innerHTML =
      '<div class="mm-modal-head">' +
        '<div class="mm-modal-title"><b>' + PR.t("论文笔记") + ' · Markmap</b><span class="mm-modal-sub">' + titleDisp + '</span></div>' +
        '<div class="mm-modal-actions">' +
          '<button type="button" class="btn icon sm" data-mm-note="expand-all" title="' + PR.t("全部展開") + '" aria-label="' + PR.t("全部展開") + '">' + ICON_EXPAND_ALL + '</button>' +
          '<button type="button" class="btn icon sm" data-mm-note="collapse-main" title="' + PR.t("收合至主分支") + '" aria-label="' + PR.t("收合至主分支") + '">' + ICON_COLLAPSE_MAIN + '</button>' +
          '<button type="button" class="btn sm line" data-mm-note="export" title="' + label(PR.t("导出 SVG")) + '">' + PR.t("导出") + '</button>' +
          '<button type="button" class="btn sm line" data-mm-note="fit">' + PR.t("适合窗口") + '</button>' +
          '<button type="button" class="btn icon sm" data-mm-note="out" aria-label="' + label(PR.t("缩小思维导图")) + '">−</button>' +
          '<button type="button" class="btn icon sm" data-mm-note="in" aria-label="' + label(PR.t("放大思维导图")) + '">+</button>' +
          '<button type="button" class="btn icon sm theme-btn" data-mm-note="theme" title="' + (isDark() ? PR.t("换成浅色") : PR.t("换成深色")) + '">' +
            (PR.icon ? PR.icon(isDark() ? "sun" : "moon", "sm") : "") +
          '</button>' +
          '<button type="button" class="btn icon sm" data-mm-note="close" title="' + label(PR.t("关闭")) + '" aria-label="' + label(PR.t("关闭")) + '">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="mm-modal-body pn-modal-map" id="mmModalStage">' +
        '<svg class="pn-map-svg markmap" role="img" tabindex="0" aria-label="' + label(PR.t("思维导图：拖动平移、滚轮缩放，点击圆点展开或收起")) + '"></svg>' +
        '<p class="pn-map-empty"' + (empty ? "" : " hidden") + '>' + PR.t("写下笔记，思维导图会自动出现在这里。") + '</p>' +
      '</div>';

    backdrop.classList.add("open");
    const stage = dialog.querySelector("#mmModalStage");
    const svgEl = stage.querySelector("svg");
    const modalMap = libraries.Markmap.create(svgEl, { duration: 150, maxWidth: 280, paddingX: 14, spacingVertical: 10, maxInitialScale: 1.0 });
    await modalMap.setData(JSON.parse(JSON.stringify(root)));
    if (!empty) setTimeout(() => modalMap.fit(1.0), 40);
    const modalObserver = new ResizeObserver(() => { if (!empty) modalMap.fit(1.0); });
    modalObserver.observe(stage);

    const close = () => {
      backdrop.classList.remove("open");
      modalObserver.disconnect();
      modalMap.destroy();
      dialog.innerHTML = "";
      document.removeEventListener("keydown", onKeyDown);
    };
    const onKeyDown = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKeyDown);

    backdrop.onclick = async e => {
      if (e.target === backdrop || e.target.closest('[data-mm-note="close"]')) { close(); return; }
      const act = e.target.closest("[data-mm-note]")?.dataset.mmNote;
      if (act === "fit") { modalMap.fit(1.0); return; }
      if (act === "in" || act === "out") { modalMap.rescale(act === "in" ? 1.25 : 0.8); return; }
      if (act === "export") { exportMap(modalMap, stage); return; }
      if (act === "expand-all") {
        setFoldAll(modalMap.state.data, 0);
        await modalMap.renderData();
        modalMap.fit(1.0);
        return;
      }
      if (act === "collapse-main") {
        foldBranches(modalMap.state.data, 0);
        await modalMap.renderData();
        modalMap.fit(1.0);
        return;
      }
      if (act === "theme") {
        if (typeof PR.toggleTheme === "function") PR.toggleTheme();
        else document.documentElement.dataset.theme = isDark() ? "light" : "dark";
        const btn = dialog.querySelector('[data-mm-note="theme"]');
        if (btn && PR.icon) {
          btn.innerHTML = PR.icon(isDark() ? "sun" : "moon", "sm");
          btn.title = isDark() ? PR.t("换成浅色") : PR.t("换成深色");
        }
        return;
      }
      const node = e.target.closest(".markmap-node");
      if (node && !e.target.closest("circle")) {
        selectNote(modalMap.svg.select(() => node).datum(), modalMap);
      }
    };
  }

  function openFormula(latex = "", pos = null, display = false) {
    formula = { pos, display };
    const form = workspace().querySelector(".pn-formula");
    form.hidden = false;
    form.querySelector("[data-note-latex]").value = latex;
    const type = form.querySelector("[data-note-display]");
    type.checked = display; type.disabled = pos != null;
    form.querySelector("[data-note-latex]").focus();
  }

  PR.paperNoteEditor = {
    html(body) {
      const modes = [["rich", PR.t("预览")], ["source", "Markdown"]];
      return '<div class="pn-workspace"><section class="pn-writing" aria-label="' + label(PR.t("论文笔记编辑器")) + '">' +
        '<div class="pn-bar"><div class="seg" role="group" aria-label="' + label(PR.t("笔记显示方式")) + '">' + modes.map(([key, text]) => '<button data-note-mode="' + key + '">' + text + '</button>').join("") + '</div><span class="grow"></span><button class="btn sm" data-note-map-toggle aria-controls="pnMindmap">Markmap</button></div>' +
        '<div class="pn-format"></div>' +
        '<form class="pn-formula" hidden><input class="input" data-note-latex aria-label="' + label(PR.t("LaTeX 公式")) + '" placeholder="E = mc^2"><label><input type="checkbox" data-note-display> ' + PR.t("独立公式") + '</label><button class="btn sm accent" type="submit">' + PR.t("应用") + '</button><button class="btn sm" type="button" data-note-math-cancel>' + PR.t("取消") + '</button></form>' +
        '<div class="pn-content"><div class="pn-rich-pane" spellcheck="false"><div class="pn-rich" spellcheck="false"></div></div><div class="pn-source" hidden><textarea id="paperNote" spellcheck="false" aria-label="' + label(PR.t("论文笔记 Markdown")) + '">' + PR.esc(body) + '</textarea></div></div></section>' +
        '<div class="pn-divider" role="separator" tabindex="0" aria-label="' + label(PR.t("调整笔记与思维导图的高度")) + '" aria-orientation="horizontal" aria-valuemin="25" aria-valuemax="80" aria-controls="pnMindmap" title="' + label(PR.t("拖动调整高度，方向键微调，双击恢复")) + '"></div>' +
        '<section id="pnMindmap" class="pn-mindmap" aria-label="' + label(PR.t("思维导图")) + '"><div class="pn-bar"><b>Markmap</b><span class="pn-sync">' + PR.t("随笔记同步") + '</span><span class="grow"></span>' +
        '<button type="button" class="btn icon sm" data-note-map-act="expand-all" title="' + PR.t("全部展開") + '" aria-label="' + PR.t("全部展開") + '">' + ICON_EXPAND_ALL + '</button>' +
        '<button type="button" class="btn icon sm" data-note-map-act="collapse-main" title="' + PR.t("收合至主分支") + '" aria-label="' + PR.t("收合至主分支") + '">' + ICON_COLLAPSE_MAIN + '</button>' +
        '<button class="btn sm" data-note-map-modal title="' + label(PR.t("詳細檢視")) + '">' + PR.t("詳細檢視") + '</button><button class="btn sm" data-note-map-export title="' + label(PR.t("导出 SVG")) + '">' + PR.t("导出") + '</button><button class="btn sm" data-note-zoom="fit">' + PR.t("适合窗口") + '</button><button class="btn sm" data-note-zoom="out" aria-label="' + label(PR.t("缩小思维导图")) + '">−</button><button class="btn sm" data-note-zoom="in" aria-label="' + label(PR.t("放大思维导图")) + '">+</button></div>' +
        '<div class="pn-map"><svg class="pn-map-svg" role="img" tabindex="0" aria-label="' + label(PR.t("思维导图：拖动平移、滚轮缩放，点击圆点展开或收起")) + '"></svg><p class="pn-map-empty">' + PR.t("写下笔记，思维导图会自动出现在这里。") + '</p></div></section></div>';
    },
    mount(body) {
      richSource = body; firstMap = true; mapBody = null;
      rich = libraries.createEditor({
        element: workspace().querySelector(".pn-rich"), content: body,
        onChange(text) {
          richSource = text;
          const ta = PR.$("#paperNote");
          if (ta) {
            ta.value = text;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          }
          updateSoon();
        },
        onSelection: revealSelection,
        onMathClick: (node, pos, display) => openFormula(node.attrs.latex, pos, display),
      });
      unmountToolbar = libraries.mountNoteToolbar(workspace().querySelector(".pn-format"), rich, () => openFormula());
      workspace().querySelectorAll(".pn-rich, .pn-rich-pane, .pn-prose, .ProseMirror, [contenteditable]").forEach(node => {
        node.setAttribute("spellcheck", "false");
        node.setAttribute("autocapitalize", "off");
        node.setAttribute("autocorrect", "off");
      });
      const mapSvg = workspace().querySelector(".pn-map-svg");
      map = libraries.Markmap.create(mapSvg, { duration: 150, maxWidth: 220, paddingX: 10, spacingVertical: 8, maxInitialScale: 1.0 });
      setMode(mode); setSplit(split); setMapVisible(mapVisible);
      updateMap(true);
      observer = new ResizeObserver(() => { if (mapVisible && map && !firstMap) map.fit(1.0); });
      observer.observe(workspace().querySelector(".pn-map"));
    },
    destroy() {
      updateSoon.cancel(); observer?.disconnect(); observer = null;
      if (unmountToolbar) { unmountToolbar(); unmountToolbar = null; }
      if (map) { map.destroy(); map = null; }
      if (rich) { rich.destroy(); rich = null; }
    },
    getBody: () => rich ? PR.$("#paperNote").value : null,
    update: updateSoon,
  };

  panel.addEventListener("submit", e => {
    if (!e.target.matches(".pn-formula")) return;
    e.preventDefault();
    const latex = e.target.querySelector("[data-note-latex]").value.trim();
    if (!latex) return;
    const display = e.target.querySelector("[data-note-display]").checked, chain = rich.chain().focus();
    if (formula.pos != null) {
      if (display) chain.updateBlockMath({ latex, pos: formula.pos });
      else chain.updateInlineMath({ latex, pos: formula.pos });
    } else if (display) chain.insertBlockMath({ latex });
    else chain.insertInlineMath({ latex });
    chain.run(); e.target.hidden = true;
  });
  panel.addEventListener("click", async e => {
    if (e.target.closest("[data-note-map-modal]")) { openMapModal(); return; }
    if (e.target.closest("[data-note-map-export]")) { exportMap(); return; }
    const actBtn = e.target.closest("[data-note-map-act]");
    if (actBtn && map) {
      const act = actBtn.dataset.noteMapAct;
      if (act === "expand-all") {
        setFoldAll(map.state.data, 0);
        await map.renderData();
        map.fit(1.0);
        return;
      }
      if (act === "collapse-main") {
        foldBranches(map.state.data, 0);
        await map.renderData();
        map.fit(1.0);
        return;
      }
    }
    if (e.target.closest("[data-note-map-toggle]")) {
      setMapVisible(!mapVisible);
      PR.ls.set("easyread-note-map-visible", mapVisible);
      return;
    }
    if (e.target.closest(".pn-prose")) { revealSelection(); return; }
    if (e.target.closest("[data-note-math-cancel]")) { workspace().querySelector(".pn-formula").hidden = true; rich.commands.focus(); return; }
    const node = e.target.closest(".markmap-node");
    if (node && !e.target.closest("circle")) { selectNote(map.svg.select(() => node).datum()); return; }
    const modeButton = e.target.closest("[data-note-mode]");
    if (modeButton) { setMode(modeButton.dataset.noteMode); return; }
    const zoomButton = e.target.closest("[data-note-zoom]");
    if (zoomButton && map) {
      if (zoomButton.dataset.noteZoom === "fit") map.fit(1.0);
      else map.rescale(zoomButton.dataset.noteZoom === "in" ? 1.25 : 0.8);
    }
  });
  panel.addEventListener("keydown", e => {
    if (e.target.matches(".pn-map-svg")) {
      if (["+", "=", "-", "0"].includes(e.key) && map) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "0") map.fit(1.0); else map.rescale(e.key === "-" ? 0.8 : 1.25);
      }
      return;
    }
    if (!e.target.matches(".pn-divider")) return;
    const next = { ArrowUp: split - 5, ArrowDown: split + 5, Home: 25, End: 80 }[e.key];
    if (next == null) return;
    e.preventDefault(); e.stopPropagation(); setSplit(next); PR.ls.set("easyread-note-split", split);
  });
  panel.addEventListener("dblclick", e => { if (e.target.matches(".pn-divider")) { setSplit(58); PR.ls.set("easyread-note-split", split); } });
  panel.addEventListener("pointerdown", e => {
    if (!e.target.matches(".pn-divider") || e.button !== 0) return;
    e.preventDefault();
    const grip = e.target, el = workspace(), rect = el.getBoundingClientRect();
    grip.focus(); grip.setPointerCapture(e.pointerId); el.classList.add("pn-resizing");
    const move = ev => setSplit((ev.clientY - rect.top) / rect.height * 100);
    const stop = () => {
      grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", stop); grip.removeEventListener("pointercancel", stop);
      el.classList.remove("pn-resizing"); PR.ls.set("easyread-note-split", split);
    };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", stop); grip.addEventListener("pointercancel", stop);
  });
})(window.PR);
