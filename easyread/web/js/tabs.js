/* Multi-Paper Tabs Shell with Chrome-style Drag & Drop, Tab Grouping, Cross-window Detach/Attach, and LRU Virtual Tab Sleeping */
(() => {
  "use strict";

  const windowId = "win-" + Math.random().toString(36).slice(2, 9);
  const bus = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("paperread-tabs-bus") : null;
  const tabs = new Map();
  const groups = new Map();
  const selectedTabs = new Set();
  const strip = document.querySelector("#tabs");
  const scrollLeftBtn = document.querySelector("#tabScrollLeft");
  const scrollRightBtn = document.querySelector("#tabScrollRight");
  const contextMenu = document.querySelector("#tabContextMenu");
  const groupPopover = document.querySelector("#groupEditorPopover");

  let active = "library";
  let selectionAnchorId = "library";
  let maxLiveTabs = 5;
  let isDetachedWindow = new URLSearchParams(location.search).has("detached");
  let isAutoHide = false;
  let hideTimer = null;
  const tabsBar = document.querySelector(".tabs-bar");
  const hoverTrigger = document.querySelector("#tabsHoverTrigger");

  const GROUP_COLORS = [
    { id: "grey", hex: "#64748b" },
    { id: "blue", hex: "#2563eb" },
    { id: "cyan", hex: "#0891b2" },
    { id: "green", hex: "#16a34a" },
    { id: "yellow", hex: "#ca8a04" },
    { id: "orange", hex: "#ea580c" },
    { id: "pink", hex: "#db2777" },
    { id: "purple", hex: "#9333ea" },
  ];

  const t = (text, vars) => {
    let res = window.PR?.t ? window.PR.t(text, vars) : text;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) res = res.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
    return res;
  };

  function colorForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
    const idx = Math.abs(hash) % GROUP_COLORS.length;
    return GROUP_COLORS[idx].hex;
  }

  function notify(text) {
    const el = document.querySelector("#message");
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  function syncTheme(tab) {
    if (!tab?.frame?.contentDocument) return;
    const theme = tab.frame.contentDocument.documentElement.dataset.theme;
    if (active === tab.id && theme) document.documentElement.dataset.theme = theme;
  }

  /* ---------------- Overflow Scroll Handling ---------------- */
  function updateScrollButtons() {
    if (!strip || !scrollLeftBtn || !scrollRightBtn) return;
    const overflow = strip.scrollWidth > strip.clientWidth + 2;
    scrollLeftBtn.hidden = !overflow;
    scrollRightBtn.hidden = !overflow;
    if (overflow) {
      scrollLeftBtn.disabled = strip.scrollLeft <= 2;
      scrollRightBtn.disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
    }
  }

  if (strip) {
    strip.addEventListener("scroll", updateScrollButtons, { passive: true });
    strip.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(updateScrollButtons).observe(strip);
    }
  }
  if (scrollLeftBtn) scrollLeftBtn.onclick = () => strip.scrollBy({ left: -220, behavior: "smooth" });
  if (scrollRightBtn) scrollRightBtn.onclick = () => strip.scrollBy({ left: 220, behavior: "smooth" });

  /* ---------------- Tab Groups ---------------- */
  function getGroup(groupId) {
    return groups.get(groupId);
  }

  function createGroup(id, title, colorHex, collapsed = false) {
    const cleanTitle = (title && title.startsWith("cat:")) ? title.slice(4) : (title || (id.startsWith("cat:") ? id.slice(4) : id));
    if (groups.has(id)) {
      const g = groups.get(id);
      if (cleanTitle) g.title = cleanTitle;
      if (colorHex) g.color = colorHex;
      renderGroupChip(g);
      return g;
    }
    const color = colorHex || colorForName(cleanTitle || id);
    const chip = document.createElement("div");
    chip.className = "tab-group-chip";
    if (!chip.dataset) chip.dataset = {};
    chip.dataset.groupId = id;
    chip.style?.setProperty?.("--group-color", color);
    chip.style?.setProperty?.("--group-bg", color + "1a");

    const dot = document.createElement("span");
    dot.className = "group-dot";
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = cleanTitle;
    const count = document.createElement("span");
    count.className = "group-count";

    chip.append(dot, label, count);
    const group = { id, title: cleanTitle, color, collapsed, node: chip };
    groups.set(id, group);

    chip.onclick = (e) => {
      e.stopPropagation();
      toggleGroupCollapse(id);
    };
    chip.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showGroupPopover(group, e.clientX, e.clientY);
    };
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => {
      draggedGroupId = id;
      const members = [...tabs.values()].filter(t => t.group === id);
      const movingIds = members.map(t => t.id);
      const payload = {
        sourceWindowId: windowId,
        type: "paperread-group",
        groupId: id,
        tabs: movingIds.map(tId => {
          const tObj = tabs.get(tId);
          return { id: tObj.id, url: tObj.url, title: tObj.title, group: tObj.group };
        }),
        groups: [{ id: group.id, title: group.title, color: group.color }],
      };
      e.dataTransfer.setData("application/x-paperread-tab", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
    });
    chip.addEventListener("dragend", () => {
      draggedGroupId = null;
    });

    renderGroupChip(group);
    return group;
  }

  function renderGroupChip(group) {
    const chip = group.node;
    const cleanTitle = (group.title && group.title.startsWith("cat:")) ? group.title.slice(4) : group.title;
    group.title = cleanTitle;
    chip.style?.setProperty?.("--group-color", group.color);
    chip.style?.setProperty?.("--group-bg", group.color + "1a");
    chip.querySelector(".group-label").textContent = cleanTitle;
    chip.classList.toggle("collapsed", group.collapsed);

    const members = [...tabs.values()].filter(t => t.group === group.id);
    const countEl = chip.querySelector(".group-count");
    countEl.textContent = group.collapsed ? `(${members.length})` : "";

    members.forEach(tab => {
      tab.node.classList.toggle("group-collapsed", group.collapsed);
      tab.node.classList.toggle("in-group", true);
      tab.node.style?.setProperty?.("--group-color", group.color);
    });

    // Keep chip placed immediately before its first member tab if attached
    if (members.length > 0 && chip.parentElement === strip) {
      const firstTabNode = members[0].node;
      if (chip.nextSibling !== firstTabNode) {
        strip.insertBefore(chip, firstTabNode);
      }
    }
    updateScrollButtons();
  }

    function syncGroupPositions() {
    groups.forEach(group => {
      const members = [...tabs.values()].filter(t => t.group === group.id && t.node.parentElement === strip);
      if (members.length > 0) {
        const firstTabNode = members[0].node;
        if (group.node.nextSibling !== firstTabNode) {
          strip.insertBefore(group.node, firstTabNode);
        }
      }
    });
    const newTabBtn = document.querySelector("#newTab");
    if (newTabBtn && strip.lastChild !== newTabBtn) {
      strip.append(newTabBtn);
    }
  }

  function toggleGroupCollapse(groupId) {
    const group = groups.get(groupId);
    if (!group) return;
    group.collapsed = !group.collapsed;
    renderGroupChip(group);
    if (group.collapsed) {
      const activeTab = tabs.get(active);
      if (activeTab?.group === groupId) {
        // Active tab collapsed, select another visible tab
        const visibleTabs = [...tabs.values()].filter(t => !t.group || !groups.get(t.group)?.collapsed);
        if (visibleTabs.length > 0) select(visibleTabs[0].id);
        else select("library");
      }
    }
  }

  function setTabGroup(tabId, groupId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.id === "library") return;
    const oldGroupId = tab.group;
    tab.group = groupId;
    if (!groupId) {
      tab.node.classList.remove("in-group", "group-collapsed");
      tab.node.style?.removeProperty?.("--group-color");
    }
    if (oldGroupId && groups.has(oldGroupId)) {
      const rem = [...tabs.values()].filter(t => t.group === oldGroupId);
      if (rem.length === 0) removeGroup(oldGroupId, false);
      else renderGroupChip(groups.get(oldGroupId));
    }
    if (groupId && groups.has(groupId)) {
      const group = groups.get(groupId);
      if (!group.node.parentElement) strip.insertBefore(group.node, tab.node);
      renderGroupChip(group);
    }
  }

  function removeGroup(groupId, closeTabs = false) {
    const group = groups.get(groupId);
    if (!group) return;
    const members = [...tabs.values()].filter(t => t.group === groupId);
    if (closeTabs) {
      members.forEach(t => void close(t.id));
    } else {
      members.forEach(t => setTabGroup(t.id, null));
    }
    group.node.remove();
    groups.delete(groupId);
    updateScrollButtons();
  }

  /* ---------------- Virtual Tabs & LRU Sleeping ---------------- */
  function enforceMemoryLimit() {
    const liveTabs = [...tabs.values()].filter(t => t.id !== "library" && !t.sleeping);
    if (liveTabs.length <= maxLiveTabs) return;

    // Pick oldest non-active tab that is not being saved
    const candidates = liveTabs
      .filter(t => t.id !== active && !t.closing && !selectedTabs.has(t.id))
      .sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));

    if (candidates.length > 0) {
      void sleepTab(candidates[0].id);
    }
  }

  async function sleepTab(id) {
    const tab = tabs.get(id);
    if (!tab || id === "library" || tab.sleeping || tab.closing) return;
    if (tab.id === active) return; // Do not sleep active tab

    await save(tab);
    const win = tab.frame.contentWindow;
    tab.sleepState = {
      url: tab.url,
      scrollY: win?.scrollY || tab.lastScrollY || 0,
      progress: win?.PR?.progressOp ? win.PR.progressOp() : null,
      title: tab.title || tab.button.textContent,
    };
    tab.observer?.disconnect();
    tab.themeObserver?.disconnect();
    try { tab.frame.src = "about:blank"; } catch (_) {}
    tab.frame.remove();
    tab.sleeping = true;
    tab.node.classList.add("sleeping");

    if (!tab.node.querySelector(".tab-sleep-badge")) {
      const badge = document.createElement("span");
      badge.className = "tab-sleep-badge";
      badge.textContent = "☾";
      badge.title = t("此分頁已休眠以節省記憶體，點擊即可恢復");
      tab.button.prepend(badge);
    }
  }

  function wakeTab(id) {
    const tab = tabs.get(id);
    if (!tab || !tab.sleeping) return;

    tab.sleeping = false;
    tab.node.classList.remove("sleeping");
    tab.node.querySelector(".tab-sleep-badge")?.remove();

    const frame = document.createElement("iframe");
    frame.className = "paper-pane inactive";
    frame.id = "pane-" + id;
    frame.title = tab.title || tab.button.textContent;
    tab.frame = frame;
    document.querySelector("#panes").append(frame);

    frame.addEventListener("load", () => {
      bind(tab);
      const win = frame.contentWindow;
      if (tab.sleepState?.scrollY && win) {
        setTimeout(() => win.scrollTo({ top: tab.sleepState.scrollY, behavior: "auto" }), 150);
      }
    });
    frame.src = tab.sleepState?.url || tab.url;
  }

  /* ---------------- Selection & Switching ---------------- */
  function select(id) {
    if (!tabs.has(id)) return;
    const previous = tabs.get(active);
    if (previous && active !== id) {
      const win = previous.frame.contentWindow;
      if (win?.scrollY != null) previous.lastScrollY = win.scrollY;
      win?.PR?.captureProgress?.();
      // Freeze previous pane after backgrounding
      previous.frame?.classList.add("frozen");
    }

    const tab = tabs.get(id);
    if (tab.sleeping) wakeTab(id);
    if (id === "library") {
      const libTitle = tab.frame?.contentWindow?.PR?.t ? tab.frame.contentWindow.PR.t("文献库") : (window.PR?.t ? window.PR.t("文献库") : t("文献库"));
      const textEl = tab.button.querySelector(".tab-text");
      if (textEl) textEl.textContent = libTitle;
      tab.title = libTitle;
    }

    active = id;
    tab.lastActiveAt = Date.now();

    for (const [key, tObj] of tabs) {
      const selected = key === id;
      tObj.node.classList.toggle("active", selected);
      tObj.button.setAttribute("aria-selected", String(selected));
      tObj.button.tabIndex = selected ? 0 : -1;
      if (tObj.frame) {
        tObj.frame.classList.toggle("inactive", !selected);
        if (selected) tObj.frame.classList.remove("frozen");
        tObj.frame.setAttribute("aria-hidden", String(!selected));
        tObj.frame.inert = !selected;
      }
    }

    syncTheme(tab);
    if (tab.checkModal) tab.checkModal();
    else document.body?.classList?.remove("modal-open", "modal-mindmap-dark");
    const rawTitle = tab.button.querySelector?.(".tab-text")?.textContent || tab.button.textContent || tab.title || "";
    document.title = String(rawTitle).replace(/^☾\s*/, "") + " · PaperRead";
    tab.node.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (tab.frame?.contentWindow) {
      try { tab.frame.contentWindow.focus(); } catch (_) {}
      if (tab.lastScrollY && tab.frame.contentWindow.scrollY === 0) {
        tab.frame.contentWindow.scrollTo({ top: tab.lastScrollY, behavior: "auto" });
      }
    }

    // Expand group if active tab belongs to a collapsed group
    if (tab.group && groups.get(tab.group)?.collapsed) {
      toggleGroupCollapse(tab.group);
    }

    enforceMemoryLimit();
    updateScrollButtons();
  }

  function selectMultiple(ids, clearExisting = true) {
    if (clearExisting) selectedTabs.clear();
    ids.forEach(id => {
      if (id !== "library" && tabs.has(id)) selectedTabs.add(id);
    });
    tabs.forEach((tab, id) => {
      tab.node.classList.toggle("multi-selected", selectedTabs.has(id));
    });
  }

  function clearMultiSelection() {
    selectedTabs.clear();
    tabs.forEach(tab => tab.node.classList.remove("multi-selected"));
  }

  async function save(tab) {
    if (!tab.frame?.contentWindow) return true;
    const pr = tab.frame.contentWindow.PR;
    try {
      pr?.finishPanelNote?.();
      pr?.autosaveNote?.flush();
      await pr?.flushPrefs?.();
      return (await pr?.flushProgress?.()) !== false;
    } catch (_) {
      return true;
    }
  }

  async function close(id) {
    if (id === "library") return;
    const tab = tabs.get(id);
    if (!tab || tab.closing) return;
    tab.closing = true;
    try {
      if (!(await save(tab))) throw new Error("save failed");
      const ids = [...tabs.keys()], index = ids.indexOf(id);
      if (active === id) select(ids[index - 1] || "library");
      tab.observer?.disconnect();
      tab.themeObserver?.disconnect();
      tab.frame?.remove();
      tab.node.remove();
      const groupId = tab.group;
      tabs.delete(id);
      selectedTabs.delete(id);
      if (groupId && groups.has(groupId)) {
        const remaining = [...tabs.values()].filter(t => t.group === groupId);
        if (remaining.length === 0) {
          removeGroup(groupId, false);
        } else {
          renderGroupChip(groups.get(groupId));
        }
      }
      syncGroupPositions();
      updateScrollButtons();

      if (isDetachedWindow && [...tabs.keys()].filter(k => k !== "library").length === 0) {
        window.close();
      }
    } catch (_) {
      notify(t("尚未保存成功，請保持標籤打開，稍後重試"));
    } finally {
      tab.closing = false;
    }
  }

  async function closeSelectedTabs() {
    const ids = selectedTabs.size > 0 ? [...selectedTabs] : [active];
    for (const id of ids) {
      if (id !== "library") await close(id);
    }
    clearMultiSelection();
  }

  /* ---------------- Keyboard Shortcuts ---------------- */
  function keyboard(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const ids = [...tabs.keys()], step = e.shiftKey ? -1 : 1;
      select(ids[(ids.indexOf(active) + step + ids.length) % ids.length]);
    } else if (e.key.toLowerCase() === "w") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (selectedTabs.size > 1 && selectedTabs.has(active)) {
        void closeSelectedTabs();
      } else {
        void close(active);
      }
    }
  }

  /* ---------------- FLIP Drag & Drop and Detach ---------------- */
  let draggedTabId = null;
  let draggedGroupId = null;
  let dragAttachedElsewhere = false;

  function initDragAndDrop(tab) {
    const node = tab.node;
    node.draggable = true;

    node.addEventListener("dragstart", (e) => {
      draggedTabId = tab.id;
      dragAttachedElsewhere = false;
      node.classList.add("is-dragging");
      const movingIds = selectedTabs.has(tab.id) ? [...selectedTabs] : [tab.id];
      const movingGroupIds = new Set(movingIds.map(id => tabs.get(id)?.group).filter(Boolean));
      const payload = {
        sourceWindowId: windowId,
        type: "paperread-tab",
        tabs: movingIds.map(id => {
          const t = tabs.get(id);
          return { id: t.id, url: t.url, title: t.title, group: t.group };
        }),
        groups: [...movingGroupIds].map(gid => {
          const g = groups.get(gid);
          const cleanName = gid.startsWith("cat:") ? gid.slice(4) : gid;
          return g ? { id: g.id, title: g.title, color: g.color } : {
            id: gid,
            title: cleanName,
            color: colorForName(cleanName),
          };
        }),
      };
      e.dataTransfer.setData("application/x-paperread-tab", JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "move";
    });

    node.addEventListener("dragend", async (e) => {
      node.classList.remove("is-dragging");
      document.body?.classList?.remove("is-dragging-over");
      const movingIds = selectedTabs.has(tab.id) ? [...selectedTabs] : [tab.id];

      if (dragAttachedElsewhere || !tabs.has(tab.id)) {
        draggedTabId = null;
        return;
      }

      // Check if dropped into another window which accepted move
      if (e.dataTransfer?.dropEffect === "move") {
        const ackRaw = localStorage.getItem("easyread-attached-ack-" + windowId);
        if (ackRaw) {
          try {
            const ack = JSON.parse(ackRaw);
            dragAttachedElsewhere = true;
            removeAttachedTabs(ack.tabIds);
            localStorage.removeItem("easyread-attached-ack-" + windowId);
            draggedTabId = null;
            return;
          } catch (_) {}
        }
      }

      // Check if dropped outside current window (Detach)
      const rect = strip.getBoundingClientRect();
      const isOutside = (
        e.clientY < rect.top - 40 ||
        e.clientY > rect.bottom + 60 ||
        e.clientX < -50 ||
        e.clientX > window.innerWidth + 50
      );

      if (isOutside && tab.id !== "library" && e.dataTransfer?.dropEffect !== "move") {
        await new Promise(r => setTimeout(r, 60));
        if (dragAttachedElsewhere || !tabs.has(tab.id)) {
          draggedTabId = null;
          return;
        }
        await detachTabs(movingIds, { x: e.screenX, y: e.screenY });
      }

      draggedTabId = null;
    });

    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if ((!draggedTabId && !draggedGroupId) || tab.id === "library") return;

      if (draggedGroupId) {
        const group = groups.get(draggedGroupId);
        if (!group) return;
        const members = [...tabs.values()].filter(t => t.group === draggedGroupId);
        const memberNodes = [group.node, ...members.map(m => m.node)];
        if (memberNodes.includes(node)) return;

        const targetRect = node.getBoundingClientRect();
        const midX = targetRect.left + targetRect.width / 2;
        const insertBefore = e.clientX < midX;
        const refNode = insertBefore ? node : node.nextSibling;
        memberNodes.forEach(n => strip.insertBefore(n, refNode));
        syncGroupPositions();
        updateScrollButtons();
        return;
      }

      if (draggedTabId === tab.id) return;
      const movingIds = selectedTabs.has(draggedTabId) ? [...selectedTabs] : [draggedTabId];
      if (movingIds.includes(tab.id)) return;

      const targetRect = node.getBoundingClientRect();
      const midX = targetRect.left + targetRect.width / 2;
      const insertBefore = e.clientX < midX;

      // Animate with FLIP
      const tabNodes = [...strip.children];
      const firstPositions = new Map(tabNodes.map(n => [n, n.getBoundingClientRect().left]));

      if (insertBefore) {
        strip.insertBefore(tabs.get(draggedTabId).node, node);
      } else {
        strip.insertBefore(tabs.get(draggedTabId).node, node.nextSibling);
      }
      syncGroupPositions();

      tabNodes.forEach(n => {
        const first = firstPositions.get(n);
        const last = n.getBoundingClientRect().left;
        const delta = first - last;
        if (delta) {
          n.style.transform = `translateX(${delta}px)`;
          n.style.transition = "none";
          requestAnimationFrame(() => {
            n.style.transform = "";
            n.style.transition = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
          });
        }
      });
      updateScrollButtons();
    });
  }

  function removeAttachedTabs(tabIds) {
    const affectedGroups = new Set();
    (tabIds || []).forEach(id => {
      const tab = tabs.get(id);
      if (tab && id !== "library") {
        if (tab.group) affectedGroups.add(tab.group);
        tab.observer?.disconnect();
        tab.themeObserver?.disconnect();
        tab.frame?.remove();
        tab.node.remove();
        tabs.delete(id);
        selectedTabs.delete(id);
      }
    });
    affectedGroups.forEach(gid => {
      if (groups.has(gid)) {
        const remaining = [...tabs.values()].filter(t => t.group === gid);
        if (remaining.length === 0) {
          removeGroup(gid, false);
        } else {
          renderGroupChip(groups.get(gid));
        }
      }
    });
    syncGroupPositions();
    select(tabs.keys().next().value || "library");
    updateScrollButtons();
    if (isDetachedWindow && [...tabs.keys()].filter(k => k !== "library").length === 0) {
      if (window.easyreadDesktop?.closeCurrentWindow) {
        window.easyreadDesktop.closeCurrentWindow();
      } else {
        window.close();
      }
    }
  }

  async function detachTabs(tabIds, screenPos) {
    const items = tabIds.map(id => tabs.get(id)).filter(t => t && t.id !== "library");
    if (items.length === 0) return;

    for (const t of items) await save(t);

    const token = "dt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const activeGroupIds = new Set(items.map(t => t.group).filter(Boolean));
    const payload = {
      sourceWindowId: windowId,
      tabs: items.map(t => ({ id: t.id, url: t.url, title: t.title, group: t.group })),
      groups: [...groups.values()]
        .filter(g => activeGroupIds.has(g.id))
        .map(g => ({ id: g.id, title: g.title, color: g.color })),
      autoHide: isAutoHide,
    };
    try { localStorage.setItem("easyread-detached-" + token, JSON.stringify(payload)); } catch (_) {}

    const screenW = (typeof window !== "undefined" && window.screen?.availWidth) || 1920;
    const screenH = (typeof window !== "undefined" && window.screen?.availHeight) || 1080;
    const halfW = Math.max(600, Math.floor(screenW / 2));
    const currentX = (typeof window !== "undefined" && window.screenX) || 0;
    const targetX = currentX >= halfW / 2 ? 0 : halfW;

    if (window.easyreadDesktop?.openDetachedWindow) {
      await window.easyreadDesktop.openDetachedWindow(token, { x: targetX, y: 0, width: halfW, height: screenH });
    } else {
      if (typeof window !== "undefined") {
        try {
          const availLeft = window.screen?.availLeft || 0;
          const availTop = window.screen?.availTop || 0;
          window.moveTo?.(availLeft, availTop);
          window.resizeTo?.(halfW, screenH);
        } catch (_) {}
      }
      window.open(
        `/web/tabs.html?detached=${encodeURIComponent(token)}`,
        "_blank",
        `popup=yes,width=${halfW},height=${screenH},left=${targetX},top=0,resizable=yes`
      );
      setTimeout(() => {
        if (typeof window !== "undefined" && window.outerWidth > halfW + 100) {
          notify(t("提示：瀏覽器限制腳本縮小原視窗，可按鍵盤 Win + ← 將原視窗貼齊左側並排"));
        }
      }, 500);
    }

    const affectedGroups = new Set(items.map(t => t.group).filter(Boolean));
    for (const t of items) {
      t.observer?.disconnect();
      t.themeObserver?.disconnect();
      t.frame?.remove();
      t.node.remove();
      tabs.delete(t.id);
      selectedTabs.delete(t.id);
    }
    affectedGroups.forEach(gid => {
      if (groups.has(gid)) {
        const remaining = [...tabs.values()].filter(t => t.group === gid);
        if (remaining.length === 0) {
          removeGroup(gid, false);
        } else {
          renderGroupChip(groups.get(gid));
        }
      }
    });
    syncGroupPositions();
    select(tabs.keys().next().value || "library");
    updateScrollButtons();

    if (isDetachedWindow && [...tabs.keys()].filter(k => k !== "library").length === 0) {
      if (window.easyreadDesktop?.closeCurrentWindow) {
        window.easyreadDesktop.closeCurrentWindow();
      } else {
        window.close();
      }
    }
  }

  /* Handle cross-window attach drop */
  if (strip) {
    strip.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (isAutoHide) revealTabBar();
    });
    strip.addEventListener("drop", async (e) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/x-paperread-tab");
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        if (data.sourceWindowId === windowId) return; // Same window handled by dragover

        // Attach tabs from other window
        for (const item of data.tabs || []) {
          if (!tabs.has(item.id)) {
            create(item.id, item.url, item.title || t("論文"));
            if (item.group) {
              if (!groups.has(item.group)) {
                const groupInfo = (data.groups || []).find(g => g.id === item.group);
                const title = groupInfo?.title || (item.group.startsWith("cat:") ? item.group.slice(4) : item.group);
                const color = groupInfo?.color || colorForName(title);
                createGroup(item.group, title, color);
              }
              setTabGroup(item.id, item.group);
            }
          }
          select(item.id);
        }
        const ackData = {
          type: "TAB_ATTACHED_ACK",
          sourceWindowId: data.sourceWindowId,
          tabIds: data.tabs.map(t => t.id),
          timestamp: Date.now(),
        };
        bus?.postMessage(ackData);
        try {
          localStorage.setItem("easyread-attached-ack-" + data.sourceWindowId, JSON.stringify(ackData));
        } catch (_) {}
      } catch (_) {}
    });
  }

  bus?.addEventListener("message", (e) => {
    const data = e.data;
    if (data?.type === "TAB_ATTACHED_ACK" && data.sourceWindowId === windowId) {
      dragAttachedElsewhere = true;
      removeAttachedTabs(data.tabIds);
    }
  });

  /* ---------------- Auto-hide Tab Bar ---------------- */
  function isMenuOpen() {
    return (!contextMenu?.hidden) || (!groupPopover?.hidden);
  }

  function revealTabBar() {
    clearTimeout(hideTimer);
    if (!tabsBar) return;
    tabsBar.classList.add("tabs-revealed");
  }

  function scheduleHideTabBar(delay = 280) {
    if (!isAutoHide || isMenuOpen()) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!isAutoHide || isMenuOpen()) return;
      if (tabsBar && !tabsBar.matches?.(":hover") && !hoverTrigger?.matches?.(":hover")) {
        tabsBar.classList.remove("tabs-revealed");
      }
    }, delay);
  }

  function setAutoHide(enabled, persist = true) {
    isAutoHide = !!enabled;
    document.body?.classList?.toggle("autohide-tabs", isAutoHide);
    if (isAutoHide) {
      scheduleHideTabBar(400);
    } else {
      revealTabBar();
    }
    if (persist) {
      try {
        const ui = JSON.parse(localStorage.getItem("easyread-ui") || "{}");
        ui.features = ui.features || {};
        ui.features.autohide_tabs = isAutoHide;
        localStorage.setItem("easyread-ui", JSON.stringify(ui));
        if (typeof fetch === "function") {
          fetch("/api/prefs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ui: { features: ui.features } })
          }).catch(() => {});
        }
      } catch (_) {}
    }
  }

  function loadAutoHideFromPrefs() {
    try {
      const ui = JSON.parse(localStorage.getItem("easyread-ui") || "{}");
      if (ui?.features && typeof ui.features.autohide_tabs === "boolean") {
        setAutoHide(ui.features.autohide_tabs, false);
      } else {
        setAutoHide(false, false);
      }
    } catch (_) {
      setAutoHide(false, false);
    }
  }

  if (hoverTrigger) {
    hoverTrigger.addEventListener("mouseenter", () => {
      if (isAutoHide) revealTabBar();
    });
    hoverTrigger.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (isAutoHide) revealTabBar();
    });
    hoverTrigger.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (isAutoHide) revealTabBar();
    });
  }
  if (tabsBar) {
    tabsBar.addEventListener("mouseenter", () => {
      if (isAutoHide) revealTabBar();
    });
    tabsBar.addEventListener("mouseleave", () => {
      if (isAutoHide) scheduleHideTabBar(280);
    });
    tabsBar.addEventListener("dragenter", () => {
      if (isAutoHide) revealTabBar();
    });
    tabsBar.addEventListener("dragover", () => {
      if (isAutoHide) revealTabBar();
    });
  }

  window.addEventListener?.("dragenter", (e) => {
    document.body?.classList?.add("is-dragging-over");
    if (isAutoHide && e.clientY <= 65) {
      revealTabBar();
    }
  });

  window.addEventListener?.("dragover", (e) => {
    if (isAutoHide) {
      if (e.clientY <= 65) {
        revealTabBar();
      } else if (e.clientY > 95) {
        scheduleHideTabBar(200);
      }
    }
  });

  window.addEventListener?.("dragleave", (e) => {
    if (e.relatedTarget === null) {
      document.body?.classList?.remove("is-dragging-over");
      if (isAutoHide) scheduleHideTabBar(300);
    }
  });

  window.addEventListener?.("drop", () => {
    document.body?.classList?.remove("is-dragging-over");
    if (isAutoHide) scheduleHideTabBar(350);
  });

  /* ---------------- Context Menu & Popover ---------------- */
  function showContextMenu(e, tabId) {
    if (!contextMenu) return;
    const isLib = tabId === "library";
    const tab = tabs.get(tabId);
    if (!tab) return;

    if (!selectedTabs.has(tabId)) {
      clearMultiSelection();
      selectedTabs.add(tabId);
      tab.node.classList.add("multi-selected");
    }

    const count = selectedTabs.size;
    contextMenu.innerHTML = "";
    const addItem = (action, label, parent = contextMenu) => {
      const el = document.createElement("div");
      el.className = "tab-menu-item";
      el.dataset.action = action;
      el.textContent = label;
      parent.append(el);
      return el;
    };
    const addSep = (parent = contextMenu) => {
      const sep = document.createElement("div");
      sep.className = "tab-menu-separator";
      parent.append(sep);
    };

    if (!isLib) {
      const subWrap = document.createElement("div");
      subWrap.className = "tab-menu-submenu-wrap";
      const subTitle = document.createElement("div");
      subTitle.className = "tab-menu-item";
      subTitle.innerHTML = `<span>${t("加入分頁群組")}</span><span class="menu-arrow">▸</span>`;
      const submenu = document.createElement("div");
      submenu.className = "tab-menu-submenu";
      addItem("new-group", "+ " + t("新建群組"), submenu);
      if (groups.size > 0) addSep(submenu);
      groups.forEach(g => {
        const it = document.createElement("div");
        it.className = "tab-menu-item";
        it.dataset.action = "set-group";
        it.dataset.group = g.id;
        const dot = document.createElement("span");
        dot.className = "group-dot";
        dot.style.background = g.color;
        const titleSpan = document.createElement("span");
        titleSpan.className = "group-title";
        titleSpan.textContent = g.title;
        it.append(dot, titleSpan);
        submenu.append(it);
      });
      subWrap.append(subTitle, submenu);
      contextMenu.append(subWrap);

      if (tab.group) addItem("remove-group", t("從群組移出"));
      addItem("detach-tab", t("移至新視窗 (雙開)"));
      addItem("sleep-tab", count > 1 ? t("休眠已選分頁") : t("休眠此分頁"));
      addSep();
      addItem("close-selected", count > 1 ? t("關閉已選的 {n} 個分頁", { n: count }) : t("關閉分頁"));
      addItem("close-others", t("關閉其他分頁"));
      addItem("close-right", t("關閉右側分頁"));
    } else {
      addItem("close-others", t("關閉其他分頁"));
    }
    addSep();
    addItem("toggle-autohide", isAutoHide ? t("✓ 自動隱藏標籤列") : t("自動隱藏標籤列"));
    contextMenu.hidden = false;

    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - 250);
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    const clickHandler = (ev) => {
      const item = ev.target.closest(".tab-menu-item");
      if (!item) return;
      const action = item.dataset.action;
      if (action === "new-group") {
        const title = prompt(t("請輸入群組名稱："), t("未命名群組"));
        if (title) {
          const g = createGroup("g-" + Date.now(), title);
          selectedTabs.forEach(id => setTabGroup(id, g.id));
        }
      } else if (action === "set-group") {
        const gid = item.dataset.group;
        selectedTabs.forEach(id => setTabGroup(id, gid));
      } else if (action === "remove-group") {
        selectedTabs.forEach(id => setTabGroup(id, null));
      } else if (action === "detach-tab") {
        void detachTabs([...selectedTabs], { x: e.screenX, y: e.screenY });
      } else if (action === "sleep-tab") {
        selectedTabs.forEach(id => void sleepTab(id));
      } else if (action === "close-selected") {
        void closeSelectedTabs();
      } else if (action === "close-others") {
        [...tabs.keys()].forEach(id => { if (id !== "library" && id !== tabId) void close(id); });
      } else if (action === "close-right") {
        const ids = [...tabs.keys()];
        const idx = ids.indexOf(tabId);
        ids.slice(idx + 1).forEach(id => { if (id !== "library") void close(id); });
      } else if (action === "toggle-autohide") {
        setAutoHide(!isAutoHide, true);
      }
      hideContextMenu();
    };

    contextMenu.onclick = clickHandler;
  }

  function hideContextMenu() {
    if (contextMenu) contextMenu.hidden = true;
    if (isAutoHide) scheduleHideTabBar(300);
  }

  function showGroupPopover(group, clientX, clientY) {
    if (!groupPopover) return;
    groupPopover.innerHTML = "";
    const popInput = document.createElement("input");
    popInput.type = "text";
    popInput.className = "group-popover-input";
    popInput.value = group.title;
    popInput.placeholder = t("群組名稱");
    groupPopover.append(popInput);

    const colorsDiv = document.createElement("div");
    colorsDiv.className = "group-popover-colors";
    GROUP_COLORS.forEach(c => {
      const dot = document.createElement("span");
      dot.className = "group-color-dot" + (c.hex === group.color ? " active" : "");
      dot.style.background = c.hex;
      dot.dataset.hex = c.hex;
      colorsDiv.append(dot);
    });
    groupPopover.append(colorsDiv);

    const actsDiv = document.createElement("div");
    actsDiv.className = "group-popover-actions";
    const ungrpBtn = document.createElement("button");
    ungrpBtn.className = "group-popover-btn";
    ungrpBtn.dataset.act = "ungroup";
    ungrpBtn.textContent = t("解散群組");
    const clsAllBtn = document.createElement("button");
    clsAllBtn.className = "group-popover-btn danger";
    clsAllBtn.dataset.act = "close-all";
    clsAllBtn.textContent = t("關閉全部");
    actsDiv.append(ungrpBtn, clsAllBtn);
    groupPopover.append(actsDiv);
    groupPopover.hidden = false;
    const x = Math.min(clientX, window.innerWidth - 260);
    const y = Math.min(clientY, window.innerHeight - 200);
    groupPopover.style.left = `${x}px`;
    groupPopover.style.top = `${y}px`;

    const input = popInput;
    input.focus();
    input.oninput = () => {
      group.title = input.value || t("未命名群組");
      renderGroupChip(group);
    };

    groupPopover.querySelectorAll(".group-color-dot").forEach(dot => {
      dot.onclick = () => {
        group.color = dot.dataset.hex;
        renderGroupChip(group);
        groupPopover.querySelectorAll(".group-color-dot").forEach(d => d.classList.remove("active"));
        dot.classList.add("active");
      };
    });

    groupPopover.querySelector('[data-act="ungroup"]').onclick = () => {
      removeGroup(group.id, false);
      hideGroupPopover();
    };
    groupPopover.querySelector('[data-act="close-all"]').onclick = () => {
      removeGroup(group.id, true);
      hideGroupPopover();
    };
  }

  function hideGroupPopover() {
    if (groupPopover) groupPopover.hidden = true;
    if (isAutoHide) scheduleHideTabBar(300);
  }

  document.addEventListener("click", (e) => {
    if (!contextMenu?.contains(e.target)) hideContextMenu();
    if (!groupPopover?.contains(e.target)) hideGroupPopover();
  });

  /* ---------------- Open & Create Tabs ---------------- */
  async function open(raw) {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin) return;
    if (url.pathname === "/open") {
      try {
        const response = await fetch(url.href);
        if (!response.ok) throw new Error(t("沒有這篇論文"));
        return open(response.url);
      } catch (error) {
        notify(error.message);
        return;
      }
    }
    const match = url.pathname.match(/^\/read\/([a-zA-Z0-9_-]+)$/);
    if (url.origin !== location.origin || !match) return;
    const id = match[1];

    if (!tabs.has(id)) {
      create(id, url.href, t("正在打開…"));
      // Attempt to auto-categorize based on library categories
      tryAutoGroup(id);
    } else if (url.hash) {
      const tab = tabs.get(id);
      if (tab.frame?.contentWindow) tab.frame.contentWindow.location.hash = url.hash;
    }
    select(id);
  }

  function tryAutoGroup(paperId) {
    // Look up category in library frame if available
    const libWin = tabs.get("library")?.frame?.contentWindow;
    const item = libWin?.PR?.lib?.byId?.(paperId);
    if (item && item.tags && item.tags.length > 0) {
      const catName = item.tags[0];
      const groupId = "cat:" + catName;
      createGroup(groupId, catName, colorForName(catName));
      setTabGroup(paperId, groupId);
    }
  }

  function bind(tab) {
    const win = tab.frame.contentWindow;
    if (!win) return;
    const doc = win.document;
    if (win.PR?.lib) win.PR.lib.openReader = (id) => open("/read/" + encodeURIComponent(id));
    doc.addEventListener("click", (e) => {
      const link = e.target.closest("a[href]");
      if (!link) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin) return;
      if (url.pathname.startsWith("/read/")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        open(url.href);
      } else if (url.pathname === "/" || url.pathname === "/index.html") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const libTab = tabs.get("library");
        if (libTab?.frame) {
          try {
            const lwin = libTab.frame.contentWindow;
            if (!lwin || (lwin.location.pathname !== "/" && lwin.location.pathname !== "/index.html")) {
              libTab.frame.src = "/";
            }
          } catch (_) {
            libTab.frame.src = "/";
          }
        }
        select("library");
      } else if (url.pathname.startsWith("/research")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const libTab = tabs.get("library");
        if (libTab?.frame) {
          libTab.frame.src = url.pathname + url.search + url.hash;
        }
        select("library");
      }
    }, true);
    doc.addEventListener("keydown", keyboard, true);
    doc.addEventListener("mousemove", (e) => {
      if (!isAutoHide) return;
      if (e.clientY <= 12) {
        revealTabBar();
      } else if (e.clientY > 50 && tabsBar?.classList.contains("tabs-revealed")) {
        scheduleHideTabBar(240);
      }
    }, { passive: true });

    const updateTitle = () => {
      const title = tab.id === "library"
        ? (win.PR?.t ? win.PR.t("文献库") : (window.PR?.t ? window.PR.t("文献库") : t("文献库")))
        : (doc.title.replace(/\s*[·|–-]\s*(PaperRead|EasyRead).*$/i, "") || t("論文"));
      tab.title = title;
      const textEl = tab.button.querySelector(".tab-text");
      if (textEl) textEl.textContent = title;
      else tab.button.textContent = title;
      tab.button.title = title;
      if (tab.sleeping) tab.node.classList.add("sleeping");
      if (tab.frame) tab.frame.title = title;
      if (active === tab.id) document.title = title + " · PaperRead";
    };

    tab.observer?.disconnect();
    tab.observer = new MutationObserver(updateTitle);
    tab.observer.observe(doc.querySelector("title") || doc.head, { childList: true, subtree: true, characterData: true });

    tab.themeObserver?.disconnect();
    tab.themeObserver = new MutationObserver(() => syncTheme(tab));
    tab.themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const checkModal = () => {
      if (tab.id !== active) return;
      const mmOpen = doc.querySelector ? doc.querySelector("#mindmapDlg.dialog-backdrop.open") : null;
      const taskModal = doc.querySelector ? doc.querySelector("#pr-research-task-modal") : null;
      const isTaskModalOpen = taskModal && !taskModal.hidden;
      const hasModal = !!(
        doc.querySelector?.(".dialog-backdrop.open, .popover.confirm.open") ||
        mmOpen ||
        isTaskModalOpen
      );
      const isDark = (doc.documentElement?.dataset?.theme === "dark" || doc.documentElement?.getAttribute?.("data-theme") === "dark" || document.documentElement?.dataset?.theme === "dark");
      document.body?.classList?.toggle("modal-open", hasModal);
      document.body?.classList?.toggle("modal-mindmap-dark", !!(hasModal && mmOpen && isDark));
    };

    tab.modalObserver?.disconnect();
    tab.modalObserver = new MutationObserver(checkModal);
    tab.modalObserver.observe(doc.body || doc.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "hidden"],
      subtree: true,
      childList: true
    });
    tab.checkModal = checkModal;
    if (active === tab.id) checkModal();

    syncTheme(tab);
    updateTitle();
  }

  function create(id, url, title) {
    const node = document.createElement("div");
    node.className = "paper-tab";
    if (id === "library") node.classList.add("tab-library");
    if (!node.dataset) node.dataset = {};
    node.dataset.tabId = id;

    const button = document.createElement("button");
    button.className = "tab-title";
    button.setAttribute("role", "tab");
    button.id = "tab-" + id;

    const iconSpan = document.createElement("span");
    iconSpan.className = "tab-icon";
    iconSpan.innerHTML = '<img class="tab-mark" src="/web/paperread-mark.png" alt="">';

    const textSpan = document.createElement("span");
    textSpan.className = "tab-text";
    textSpan.textContent = title;

    button.append(iconSpan, textSpan);
    node.append(button);

    const frame = document.createElement("iframe");
    frame.className = "paper-pane inactive";
    frame.id = "pane-" + id;
    frame.title = title;
    button.setAttribute("aria-controls", frame.id);

    const tab = {
      id,
      url,
      title,
      node,
      button,
      frame,
      group: null,
      sleeping: false,
      lastActiveAt: Date.now(),
      lastScrollY: 0,
    };
    tabs.set(id, tab);

    // Click & Multi-Select handling
    button.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (id === "library") return;
        if (selectedTabs.has(id)) selectedTabs.delete(id);
        else {
          if (selectedTabs.size === 0 && active !== "library") selectedTabs.add(active);
          selectedTabs.add(id);
        }
        selectionAnchorId = id;
        selectMultiple([...selectedTabs], true);
      } else if (e.shiftKey) {
        if (id === "library") return;
        const ids = [...tabs.keys()].filter(k => k !== "library");
        const fromIdx = ids.indexOf(selectionAnchorId);
        const toIdx = ids.indexOf(id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const start = Math.min(fromIdx, toIdx);
          const end = Math.max(fromIdx, toIdx);
          selectMultiple(ids.slice(start, end + 1), true);
        }
      } else {
        clearMultiSelection();
        selectionAnchorId = id;
        if (id === "library") {
          const libTab = tabs.get("library");
          if (libTab?.frame) {
            try {
              const lwin = libTab.frame.contentWindow;
              if (lwin && lwin.location.pathname !== "/" && lwin.location.pathname !== "/index.html") {
                libTab.frame.src = "/";
              }
            } catch (_) {
              libTab.frame.src = "/";
            }
          }
        }
        select(id);
      }
    };

    if (id !== "library") {
      const x = document.createElement("button");
      x.className = "tab-close";
      x.textContent = "×";
      x.setAttribute("aria-label", t("關閉論文"));
      x.onclick = (e) => {
        e.stopPropagation();
        void close(id);
      };
      node.append(x);
      node.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          void close(id);
        }
      });
      initDragAndDrop(tab);
    }

    node.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e, id);
    };

    button.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const ids = [...tabs.keys()], pos = ids.indexOf(id);
      const next = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : (pos + (e.key === "ArrowLeft" ? -1 : 1) + ids.length) % ids.length;
      select(ids[next]);
      tabs.get(ids[next]).button.focus();
    });

    frame.addEventListener("load", () => bind(tab));
    frame.src = url;

    strip.append(node);
    const newTabBtn = document.querySelector("#newTab");
    if (newTabBtn) strip.append(newTabBtn);
    document.querySelector("#panes").append(frame);
    syncGroupPositions();
    updateScrollButtons();
  }

  function reorderTabs(newOrderIds) {
    const fragment = document.createDocumentFragment();
    newOrderIds.forEach(id => {
      const tab = tabs.get(id);
      if (tab) fragment.append(tab.node);
    });
    strip.append(fragment);
    updateScrollButtons();
  }

  /* ---------------- Bootstrap Detached Window ---------------- */
  function restoreDetachedPayload() {
    const detachedToken = new URLSearchParams(location.search).get("detached");
    if (!detachedToken) return;
    try {
      const raw = localStorage.getItem("easyread-detached-" + detachedToken);
      if (!raw) return;
      localStorage.removeItem("easyread-detached-" + detachedToken);
      const data = JSON.parse(raw);
      if (typeof data.autoHide === "boolean") {
        setAutoHide(data.autoHide, false);
      }
      (data.groups || []).forEach(g => createGroup(g.id, g.title, g.color));
      (data.tabs || []).forEach(t => {
        create(t.id, t.url, t.title);
        if (t.group) setTabGroup(t.id, t.group);
      });
      [...groups.keys()].forEach(gid => {
        const remaining = [...tabs.values()].filter(t => t.group === gid);
        if (remaining.length === 0) {
          removeGroup(gid, false);
        }
      });
      syncGroupPositions();
      if (data.tabs && data.tabs.length > 0) {
        select(data.tabs[0].id);
      }
    } catch (_) {}
  }

  /* ---------------- Event Listeners & Init ---------------- */
  document.addEventListener("keydown", keyboard, true);
  const newTabBtn = document.querySelector("#newTab");
  if (newTabBtn) newTabBtn.onclick = () => {
    if (!tabs.has("library")) create("library", "/", t("文献库"));
    select("library");
  };

  window.easyreadTabs = {
    open,
    select,
    close,
    closeSelectedTabs,
    saveAll: () => Promise.all([...tabs.values()].map(save)),
    keyboard,
    reorderTabs,
    createGroup,
    getGroups: () => [...groups.values()],
    toggleGroupCollapse,
    setTabGroup,
    removeGroup,
    selectMultiple,
    clearMultiSelection,
    sleepTab,
    wakeTab,
    setMaxLiveTabs: (n) => { maxLiveTabs = n; enforceMemoryLimit(); },
    detachTabs,
    setAutoHide,
    getAutoHide: () => isAutoHide,
  };

  window.easyreadDesktop?.onBeforeQuit(() => window.easyreadTabs.saveAll());

  window.addEventListener?.("storage", (e) => {
    if (e.key === "easyread-ui") {
      loadAutoHideFromPrefs();
    } else if (e.key === "easyread-attached-ack-" + windowId && e.newValue) {
      try {
        const ack = JSON.parse(e.newValue);
        dragAttachedElsewhere = true;
        removeAttachedTabs(ack.tabIds);
        localStorage.removeItem(e.key);
      } catch (_) {}
    }
  });

  loadAutoHideFromPrefs();

  create("library", "/", t("文献库"));
  select("library");

  restoreDetachedPayload();

  const overlay = document.querySelector("#tabsOverlay");
  if (overlay) {
    overlay.addEventListener("click", () => {
      const activeTab = tabs.get(active);
      const doc = activeTab?.frame?.contentDocument;
      if (!doc) return;
      const openBackdrop = doc.querySelector(".dialog-backdrop.open");
      if (openBackdrop) {
        openBackdrop.click();
      }
    });
  }

  const initial = new URLSearchParams(location.search).get("open");
  if (initial) void open(initial);
})();
