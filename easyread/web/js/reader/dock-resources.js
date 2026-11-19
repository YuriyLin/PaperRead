/* Figures use their existing paper reference. The map uses the research paper mind map. */
(function (PR) {
  "use strict";
  const API = "/api/research/v2/paper";
  let mapNode = null, mapCtrl = null, mapLoadedPid = null, mapLoading = false, handledTaskSig = "";
  const taskSig = (t) => (t && t.id ? t.id + ":" + (t.state || "") : "");
  const paperTitle = () => PR.state?.paper?.meta?.title_zh || PR.state?.paper?.meta?.title_en || PR.t("論文心智圖");

  function mindmapEmptyHtml() {
    return '<div class="rp-map-empty"><svg viewBox="0 0 180 104" role="img" aria-label="' + PR.t("研究心智圖示意圖") + '" xmlns="http://www.w3.org/2000/svg"><path d="M90 50 42 24M90 50 139 24M90 50 42 80M90 50 139 80" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="67" y="36" width="46" height="28" rx="10" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2"/><rect x="18" y="12" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><rect x="115" y="12" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><rect x="18" y="69" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><rect x="115" y="69" width="48" height="23" rx="8" fill="var(--surface)" stroke="currentColor"/><circle cx="90" cy="50" r="4" fill="var(--accent)"/></svg><p>' + PR.t("尚未產生心智圖") + '</p><span>' + PR.t("產生後會在這裡呈現論文的研究脈絡。") + '</span></div>';
  }

  function destroyMapCtrl() {
    if (mapCtrl) {
      mapCtrl.destroy();
      mapCtrl = null;
    }
  }

  function ensureMapShell(node) {
    if (node.dataset.dockMapInit) return;
    node.dataset.dockMapInit = "1";
    node.classList.add("dock-mindmap-view");
    node.innerHTML =
      '<div class="dock-mindmap-stage" aria-live="polite"></div>' +
      '<div class="dock-mindmap-actions">' +
        '<button type="button" class="btn accent sm" data-dock-map-gen>' + PR.t("產生／更新心智圖") + '</button>' +
        '<small class="rp-map-meta" data-dock-map-meta hidden></small>' +
      '</div>';
    const stage = node.querySelector(".dock-mindmap-stage");
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => {
        if (node.clientHeight && mapCtrl?.fitAndCenter) mapCtrl.fitAndCenter();
      }).observe(stage);
    }
    node.addEventListener("click", (e) => {
      if (e.target.closest("[data-dock-map-gen]") || e.target.closest("[data-dock-map-retry]")) {
        loadPaperMindmap(node, true);
      }
    });
  }

  function setBusy(node, busy) {
    const btn = node.querySelector("[data-dock-map-gen]");
    if (!btn) return;
    btn.disabled = busy;
    if (busy) {
      btn.setAttribute("aria-busy", "true");
      btn.textContent = PR.t("正在重新產生…");
    } else {
      btn.removeAttribute("aria-busy");
      btn.textContent = PR.t("產生／更新心智圖");
    }
  }

  function displayPaperMindmap(node, data) {
    const stage = node.querySelector(".dock-mindmap-stage");
    const metaEl = node.querySelector("[data-dock-map-meta]");
    if (!stage) return;
    destroyMapCtrl();
    const title = paperTitle();
    if (PR.mindmap?.renderPanel) {
      mapCtrl = PR.mindmap.renderPanel(stage, data, {
        title,
        onRegenerate: () => loadPaperMindmap(node, true),
      });
    } else {
      stage.textContent = data?.mermaid || "";
    }
    if (metaEl) {
      metaEl.textContent = PR.t("依目前論文文字產生 · {model}", { model: data.model || PR.t("快取結果") });
      metaEl.hidden = false;
    }
  }

  async function loadPaperMindmap(node, force = false) {
    const stage = node.querySelector(".dock-mindmap-stage");
    const metaEl = node.querySelector("[data-dock-map-meta]");
    if (!stage || !PR.pid || !PR.api) return;
    const id = encodeURIComponent(PR.pid);
    mapLoadedPid = PR.pid;
    mapLoading = true;
    destroyMapCtrl();
    if (metaEl) metaEl.hidden = true;
    if (force) {
      setBusy(node, true);
      stage.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.t("正在依據論文內文產生心智圖…") + '</span></div>';
      try {
        const res = await PR.api(API + "/" + id + "/mindmap/tasks", { method: "POST", body: { force: true } });
        if (res.task) handledTaskSig = taskSig(res.task);
        PR.researchTaskMonitor?.track(res.task, true);
        if (res.task && res.task.state === "completed" && res.task.result) {
          displayPaperMindmap(node, res.task.result);
          setBusy(node, false);
        }
      } catch (error) {
        setBusy(node, false);
        stage.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(error.message) + '</span><button type="button" class="btn sm line" data-dock-map-retry>' + PR.t("重試") + '</button></div>';
      } finally {
        mapLoading = false;
      }
      return;
    }

    stage.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.t("正在根據論文內文整理研究心智圖…") + '</span></div>';
    try {
      const result = await PR.api(API + "/" + id + "/mindmap");
      const liveTask = result?.task;
      if (liveTask) handledTaskSig = taskSig(liveTask);
      if (liveTask && ["queued", "running", "cancelling"].includes(liveTask.state)) {
        setBusy(node, true);
        stage.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.esc(liveTask.message || PR.t("正在依據論文內文產生心智圖…")) + '</span></div>';
        PR.researchTaskMonitor?.track(liveTask, false);
        return;
      }
      setBusy(node, false);
      if (!result?.mermaid) {
        stage.innerHTML = mindmapEmptyHtml();
        return;
      }
      displayPaperMindmap(node, result);
    } catch (error) {
      setBusy(node, false);
      stage.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(error.message) + '</span><button type="button" class="btn sm line" data-dock-map-retry>' + PR.t("重試") + '</button></div>';
    } finally {
      mapLoading = false;
    }
  }

  function drawMap(node) {
    mapNode = node;
    ensureMapShell(node);
    if (PR.store?.mode !== "server") {
      node.querySelector(".dock-mindmap-stage").innerHTML = mindmapEmptyHtml();
      return;
    }
    if (mapLoadedPid !== PR.pid && !mapLoading) {
      loadPaperMindmap(node, false);
    } else if (mapCtrl?.fitAndCenter) {
      setTimeout(() => mapCtrl?.fitAndCenter?.(), 20);
    }
  }

  PR.on?.("research-task-update", (status) => {
    const task = status?.mindmap;
    if (!task) return;
    const taskPid = task.paper_id || task.key || "";
    if (taskPid && taskPid !== PR.pid) return;
    const sig = taskSig(task);
    if (!mapNode || !PR.dockVisible?.("map")) {
      if (sig && sig !== handledTaskSig && ["completed", "cancelled", "failed", "interrupted"].includes(task.state)) {
        mapLoadedPid = null;
      }
      return;
    }
    const stage = mapNode.querySelector(".dock-mindmap-stage");
    if (task.state === "completed" || task.state === "cancelled") {
      if (mapLoading) return;
      if (sig === handledTaskSig && stage && !stage.querySelector(".rp-map-loading")) return;
      handledTaskSig = sig;
      setBusy(mapNode, false);
      loadPaperMindmap(mapNode, false);
    } else if (task.state === "failed" || task.state === "interrupted") {
      if (sig === handledTaskSig && stage?.querySelector(".rp-map-error")) return;
      handledTaskSig = sig;
      destroyMapCtrl();
      setBusy(mapNode, false);
      if (stage) {
        stage.innerHTML = '<div class="rp-map-error"><span>' + PR.esc(task.message ? PR.t(task.message) : PR.t("分析未完成")) + '</span><button type="button" class="btn sm line" data-dock-map-retry>' + PR.t("重試") + '</button></div>';
      }
    } else if (["queued", "running", "cancelling"].includes(task.state)) {
      handledTaskSig = sig;
      setBusy(mapNode, true);
      if (stage && !stage.querySelector(".rp-map-loading")) {
        destroyMapCtrl();
        stage.innerHTML = '<div class="rp-map-loading"><i class="spinner"></i><span>' + PR.esc(task.message ? PR.t(task.message) : PR.t("正在依據論文內文產生心智圖…")) + '</span></div>';
      }
    }
  });

  const lastFigure = new WeakMap();
  function drawFigure(block, node, lazy = false) {
    if (!block) { lastFigure.delete(node); node.textContent = PR.t("图表已变化或移除"); return; }
    const mode = PR.readingView(), translated = mode !== "original" && PR.hasTranslatedFigure?.(block) ? PR.imageUrl(block.translated_image.src) : "";
    const markup = PR.media.html(PR.media.reference(block));
    const zh = PR.textFor(block.id + "#caption") || block.caption_zh, en = block.caption_en;
    const labels = mode === "both" ? (PR.originalFirst() ? [en, zh] : [zh, en]) : [mode === "original" ? en || zh : zh || en];
    const captionText = [...new Set(labels.filter(Boolean))].join("\n");
    const signature = JSON.stringify([markup, mode, translated, PR.originalFirst(), captionText]);
    if (lastFigure.get(node) === signature) return;
    const shell = document.createElement("div");
    shell.innerHTML = markup;
    const original = shell.querySelector("img");
    if (original && lazy) original.loading = "lazy";
    if (original && translated) {
      const image = original.cloneNode(); image.src = translated; image.alt = PR.t("译图");
      if (mode === "translation") original.replaceWith(image);
      else if (PR.originalFirst()) original.after(image); else original.before(image);
    }
    const caption = shell.querySelector(".media-caption");
    if (caption) caption.textContent = captionText;
    lastFigure.set(node, signature); node.replaceChildren(...shell.childNodes);
  }
  function drawGallery(node) {
    const blocks = PR.media.blocks();
    if (!blocks.length) {
      const hint = document.createElement("p"); hint.className = "hint"; hint.textContent = PR.t("没有找到图表");
      node.replaceChildren(hint); return;
    }
    const existing = new Map(Array.from(node.children, child => [child.dataset.id, child]));
    blocks.forEach((block, i) => {
      let entry = existing.get(block.id);
      if (!entry) {
        entry = document.createElement("article"); entry.className = "dock-gallery-entry"; entry.dataset.id = block.id;
        entry.append(document.createElement("h3"), document.createElement("div"));
      }
      existing.delete(block.id);
      if (entry !== node.children[i]) node.insertBefore(entry, node.children[i] || null);
      entry.firstElementChild.textContent = PR.media.label(block);
      drawFigure(block, entry.lastElementChild, true);
    });
    existing.forEach(entry => entry.remove());
  }
  PR.renderDockResource = (key, node) => key === "map" ? drawMap(node)
    : key === "gallery" ? drawGallery(node) : drawFigure(PR.blockById[key.slice(4)], node);
  const refresh = PR.debounce(() => PR.refreshDockResource?.(), 100);
  PR.on("reader", refresh); PR.on("remote", refresh); PR.on("rendered", refresh);
})(window.PR);
