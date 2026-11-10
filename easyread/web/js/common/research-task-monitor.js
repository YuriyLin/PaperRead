/* Cross-page monitor for local research analyses. */
(function (PR) {
  "use strict";
  const PATH_API = "/api/research/v2/reading-path/tasks";
  const state = { scope: "", path: null, comparison: null, mindmap: null, smartAnnotate: null, deepAnalysis: null, sessionTaskIds: new Set(), tasks: [], timer: 0, busy: false, dialogTask: null, dialogOpen: false, returnFocus: null };
  const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
  const active = (task) => task && ["queued", "running", "cancelling"].includes(task.state);
  const esc = (value) => PR.esc(String(value || ""));
  const key = () => "paperread:research-task-acks:" + (state.scope || "unknown");
  function acknowledgedIds() {
    try { const data = JSON.parse(localStorage.getItem(key()) || "[]"); return new Set(Array.isArray(data) ? data : []); }
    catch (_) { return new Set(); }
  }
  function rememberAck(id) {
    if (!id) return;
    const ids = acknowledgedIds(); ids.add(id);
    try { localStorage.setItem(key(), JSON.stringify([...ids].slice(-100))); } catch (_) { /* notification still works for this page */ }
  }
  function taskType(task) {
    if (task?.kind === "comparison") return "comparison";
    if (task?.kind === "mindmap") return "mindmap";
    if (task?.kind === "smart-annotate") return "smart-annotate";
    if (task?.kind === "deep-analysis") return "deep-analysis";
    if (task?.kind === "reading-path" || task?.kind === "path") return "path";
    return task?.kind || "path";
  }
  function label(task) {
    const type = taskType(task);
    if (type === "comparison") return PR.t("跨論文比較");
    if (type === "mindmap") return PR.t("論文心智圖");
    if (type === "smart-annotate") return PR.t("智慧標註");
    if (type === "deep-analysis") return PR.t("論文深度剖析");
    if (type === "path") return PR.t("閱讀路徑分析");
    return task?.title || PR.t("研究分析");
  }
  function taskRunningTitle(type) {
    if (type === "path") return PR.t("正在分析閱讀路徑");
    if (type === "mindmap") return PR.t("正在整理論文心智圖…");
    if (type === "smart-annotate") return PR.t("正在進行智慧標註分析…");
    if (type === "deep-analysis") return PR.t("正在進行論文深度剖析…");
    if (type === "comparison") return PR.t("正在整理跨論文比較…");
    return PR.t("正在執行分析…");
  }
  function taskCompletedTitle(type) {
    if (type === "path") return PR.t("閱讀路徑已完成");
    if (type === "mindmap") return PR.t("論文心智圖已完成");
    if (type === "smart-annotate") return PR.t("智慧標註已完成");
    if (type === "deep-analysis") return PR.t("論文深度剖析已完成");
    if (type === "comparison") return PR.t("跨論文比較已完成");
    return PR.t("研究分析已完成");
  }
  function taskRunningHelp(type) {
    if (type === "path") return PR.t("你可以關閉此視窗，繼續使用 PaperRead；完成後會通知你。");
    if (type === "mindmap") return PR.t("心智圖整理可能需要較久；你可以關閉此視窗，繼續使用 PaperRead，完成後會通知你。");
    if (type === "smart-annotate") return PR.t("智慧標註分析可能需要較久；你可以關閉此視窗，繼續使用 PaperRead，完成後會通知你。");
    if (type === "deep-analysis") return PR.t("深度剖析可能需要較久；你可以關閉此視窗，繼續使用 PaperRead，完成後會通知你。");
    if (type === "comparison") return PR.t("跨論文比較可能需要較久；你可以關閉此視窗，繼續使用 PaperRead，完成後會通知你。");
    return PR.t("分析可能需要較久；你可以關閉此視窗，繼續使用 PaperRead，完成後會通知你。");
  }
  function resultUrl(task, retry = false) {
    const type = taskType(task);
    if (type === "path") return "/research?mode=path" + (retry ? "&retry_task=" + encodeURIComponent(task.id) : "");
    if (type === "comparison") return "/research?mode=comparisons";
    if (type === "mindmap") {
      const pid = task.paper_id || task.key || "";
      return "/read/" + encodeURIComponent(pid) + "?open=mindmap" + (retry ? "&retry_task=" + encodeURIComponent(task.id) : "");
    }
    if (type === "smart-annotate") {
      const pid = task.paper_id || task.key || "";
      return "/read/" + encodeURIComponent(pid) + "?open=smart-annotations" + (retry ? "&retry_task=" + encodeURIComponent(task.id) : "");
    }
    if (type === "deep-analysis") {
      const pid = task.paper_id || task.key || "";
      return "/read/" + encodeURIComponent(pid) + "?open=deep-analysis" + (retry ? "&retry_task=" + encodeURIComponent(task.id) : "");
    }
    return "/research";
  }
  function normalizeTask(raw) {
    if (!raw) return null;
    const task = { ...raw };
    if (task.state === "done") task.state = "completed";
    else if (task.state === "error") task.state = "failed";
    if (task.kind === "smart-annotate" && !task.stage_label) {
      if (["queued", "running"].includes(task.state)) {
        task.stage_label = task.total > 0
          ? PR.t("正在分析論文（第 {done} / {total} 批）…", { done: Math.min((task.done || 0) + 1, task.total), total: task.total })
          : (task.message || PR.t("正在進行智慧標註分析…"));
      } else if (task.state === "completed") {
        task.stage_label = task.message || PR.t("智慧標註已完成");
      }
    }
    if (task.id && active(task)) state.sessionTaskIds.add(task.id);
    return task;
  }
  function taskList() { return [state.path, state.comparison, state.mindmap, state.smartAnnotate, state.deepAnalysis].filter(Boolean); }
  function getModalTasks() {
    const all = taskList();
    const acks = acknowledgedIds();
    const relevant = all.filter((item) =>
      active(item) ||
      item.id === state.dialogTask ||
      state.sessionTaskIds.has(item.id) ||
      (terminal.has(item.state) && !item.acknowledged && !acks.has(item.id))
    );
    return relevant.length ? relevant : all;
  }
  function ack(task) {
    if (!task?.id || task.acknowledged) return;
    task.acknowledged = true; rememberAck(task.id);
    const type = taskType(task);
    if (type === "smart-annotate") return;
    const pid = task.paper_id || task.key || "";
    const url = type === "path" ? PATH_API + "/" + encodeURIComponent(task.id) + "/ack"
      : type === "mindmap" ? (pid ? "/api/research/v2/paper/" + encodeURIComponent(pid) + "/mindmap/tasks/" + encodeURIComponent(task.id) + "/ack" : "/api/research/v2/mindmap/tasks/" + encodeURIComponent(task.id) + "/ack")
      : type === "deep-analysis" ? (pid ? "/api/research/v2/paper/" + encodeURIComponent(pid) + "/deep-analysis/tasks/" + encodeURIComponent(task.id) + "/ack" : "/api/research/v2/deep-analysis/tasks/" + encodeURIComponent(task.id) + "/ack")
      : "/api/research/v1/tasks/" + encodeURIComponent(task.id) + "/ack";
    PR.api(url, { method: "POST", body: {} }).catch(() => {});
  }
  function closeDialog() {
    const modal = PR.$("#pr-research-task-modal");
    if (modal) modal.hidden = true;
    state.dialogOpen = false;
    if (state.returnFocus?.isConnected) state.returnFocus.focus();
    state.returnFocus = null;
  }
  function cancel(task) {
    const type = taskType(task);
    const pid = task.paper_id || task.key || PR.pid || "";
    const url = type === "path" ? PATH_API + "/" + encodeURIComponent(task.id) + "/cancel"
      : type === "smart-annotate" ? "/api/p/" + encodeURIComponent(pid) + "/smart-annotate-cancel"
      : type === "mindmap" ? (pid ? "/api/research/v2/paper/" + encodeURIComponent(pid) + "/mindmap/tasks/" + encodeURIComponent(task.id) + "/cancel" : "/api/research/v2/mindmap/tasks/" + encodeURIComponent(task.id) + "/cancel")
      : type === "deep-analysis" ? (pid ? "/api/research/v2/paper/" + encodeURIComponent(pid) + "/deep-analysis/tasks/" + encodeURIComponent(task.id) + "/cancel" : "/api/research/v2/deep-analysis/tasks/" + encodeURIComponent(task.id) + "/cancel")
      : "/api/research/v1/tasks/" + encodeURIComponent(task.id) + "/cancel";
    const body = type === "smart-annotate" ? { job: task.id } : {};
    task.state = "cancelling"; task.message = PR.t("正在取消分析…"); render();
    PR.api(url, { method: "POST", body }).then((result) => {
      const updated = normalizeTask(result.task || (type === "smart-annotate" ? { ...task, state: "cancelled", message: PR.t("已取消") } : result));
      if (taskType(updated) === "path") state.path = updated;
      else if (taskType(updated) === "mindmap") state.mindmap = updated;
      else if (taskType(updated) === "smart-annotate") state.smartAnnotate = updated;
      else if (taskType(updated) === "deep-analysis") state.deepAnalysis = updated;
      else state.comparison = updated;
      render();
    }).catch((error) => PR.toast(esc(PR.t(error.message))));
  }
  function renderDialog() {
    const modal = PR.$("#pr-research-task-modal");
    const task = taskList().find((item) => item.id === state.dialogTask) || state.dialogTask;
    if (!modal || !task) return;
    const wasVisible = !modal.hidden;
    const focusedAction = wasVisible ? ["continue", "cancel", "view", "retry", "settings"].find((name) =>
      document.activeElement?.hasAttribute("data-task-" + name)) : "";
    const type = taskType(task);
    const isMindmap = type === "mindmap", isSmartAnnotate = type === "smart-annotate", isDeepAnalysis = type === "deep-analysis", running = active(task);
    const runningHelp = taskRunningHelp(type);
    let title = running ? taskRunningTitle(type)
      : task.state === "completed" ? taskCompletedTitle(type)
      : task.state === "cancelled" ? PR.t("分析已取消")
      : task.state === "interrupted" ? PR.t("分析已中斷") : PR.t("分析未完成");

    const stageWhat = task.stage_label || task.message || (running ? taskRunningTitle(type) : PR.t("處理中…"));
    const dataScope = task.data_scope || PR.t("全文整理內容");
    const resultState = task.result_state || (task.state === "completed" ? "completed" : (task.state === "failed" || task.state === "interrupted") ? "failed" : task.state === "cancelled" ? "cancelled" : (running ? "running" : "unknown"));
    let resultStateText = "";
    let resultClass = "";
    if (resultState === "completed") {
      resultStateText = PR.t("已完成（結果可用）");
      resultClass = "pr-status-completed";
    } else if (resultState === "partial") {
      resultStateText = PR.t("部分完成（部分結果可用）");
      resultClass = "pr-status-partial";
    } else if (resultState === "failed" || task.state === "failed") {
      resultStateText = PR.t("分析失敗");
      resultClass = "pr-status-failed";
    } else if (resultState === "cancelled" || task.state === "cancelled") {
      resultStateText = PR.t("已取消");
      resultClass = "";
    } else {
      resultStateText = PR.t("正在處理中…");
      resultClass = "pr-status-running";
    }

    let nextStepText = "";
    if (running) {
      nextStepText = PR.t("可繼續閱讀或在背景等待，完成後將自動通知。");
    } else if (task.state === "completed") {
      nextStepText = PR.t("可立即查看詳細分析與原文依據。");
    } else if (task.state === "failed" || task.state === "interrupted") {
      nextStepText = task.error_reason ? (PR.t("失敗原因：") + task.error_reason) : PR.t("可重試任務或檢查模型設定。");
    }

    const preservedHint = task.preserved_previous
      ? '<div class="pr-task-preserved-hint">' + PR.t("已保留先前分析結果與輸入內容，可直接查看或重試。") + '</div>'
      : '';

    const modalTasks = getModalTasks();
    const tabsSig = modalTasks.map((item) => [item.id, item.state, item.phase || "", item.stage_label || ""].join(":")).join("|");
    const signature = [task.id, task.state, task.phase, stageWhat, dataScope, resultState, title, nextStepText, tabsSig].join("\n");
    if (!modal.hidden && modal.dataset.signature === signature) return;

    const controls = running
      ? '<button class="btn line" type="button" data-task-continue>' + PR.t("繼續使用") + '</button>' + (task.state === "cancelling" ? '' : '<button class="btn danger" type="button" data-task-cancel>' + PR.t("取消分析") + '</button>')
      : task.state === "completed"
        ? '<button class="btn accent" type="button" data-task-view>' + PR.t("查看結果") + '</button><button class="btn line" type="button" data-task-continue>' + PR.t("關閉") + '</button>'
        : (task.state === "failed" || task.state === "interrupted")
          ? (task.preserved_previous ? '<button class="btn line" type="button" data-task-view>' + PR.t("查看前次結果") + '</button>' : '') +
            '<button class="btn accent" type="button" data-task-retry>' + PR.t("返回重試") + '</button>' +
            '<button class="btn line" type="button" data-task-settings>' + PR.t("檢查模型設定") + '</button>' +
            '<button class="btn line" type="button" data-task-continue>' + PR.t("關閉") + '</button>'
          : '<button class="btn line" type="button" data-task-continue>' + PR.t("關閉") + '</button>';

    const detailsMarkup = '<div class="pr-task-details">' +
      '<div class="pr-task-row"><span class="pr-task-label">' + PR.t("正在做什麼") + '</span><span class="pr-task-val">' + esc(stageWhat) + '</span></div>' +
      '<div class="pr-task-row"><span class="pr-task-label">' + PR.t("資料範圍") + '</span><span class="pr-task-val">' + esc(dataScope) + '</span></div>' +
      '<div class="pr-task-row"><span class="pr-task-label">' + PR.t("結果可用性") + '</span><span class="pr-task-val ' + resultClass + '">' + esc(resultStateText) + '</span></div>' +
      (nextStepText ? '<div class="pr-task-row"><span class="pr-task-label">' + PR.t("下一步") + '</span><span class="pr-task-val">' + esc(nextStepText) + '</span></div>' : '') +
      preservedHint +
      '</div>';

    const tabsMarkup = modalTasks.length > 1
      ? '<div class="pr-task-tabs" role="tablist" aria-label="' + esc(PR.t("背景任務切換")) + '">' +
          modalTasks.map((item) => {
            const isCurrent = item.id === task.id;
            const isItemRunning = active(item);
            const dotClass = isItemRunning ? "is-running"
              : item.state === "completed" ? "is-completed"
              : (item.state === "failed" || item.state === "interrupted") ? "is-failed" : "is-cancelled";
            const stateShort = isItemRunning ? PR.t("進行中")
              : item.state === "completed" ? PR.t("已完成")
              : (item.state === "failed" || item.state === "interrupted") ? PR.t("失敗") : PR.t("已取消");
            return '<button type="button" class="pr-task-tab' + (isCurrent ? ' is-active' : '') + '" role="tab" aria-selected="' + isCurrent + '" data-task-select="' + esc(item.id) + '">' +
              '<span class="pr-task-tab-dot ' + dotClass + '"></span>' +
              '<span class="pr-task-tab-name">' + esc(label(item)) + '</span>' +
              '<span class="pr-task-tab-badge">' + esc(stateShort) + '</span>' +
            '</button>';
          }).join("") +
        '</div>'
      : '<p class="pr-task-kind">' + esc(label(task)) + '</p>';

    modal.innerHTML = '<div class="pr-task-dialog" role="dialog" aria-modal="true" aria-labelledby="pr-task-title"><div class="pr-task-head"><span class="pr-task-indicator' + (running ? ' is-running' : '') + '"></span><h2 id="pr-task-title">' + esc(title) + '</h2><button type="button" class="pr-task-close" data-task-continue aria-label="' + esc(PR.t("關閉")) + '">×</button></div>' + tabsMarkup + detailsMarkup + '<div class="pr-task-actions">' + controls + '</div></div>';
    modal.dataset.signature = signature;
    modal.hidden = false;
    state.dialogOpen = true;
    if (terminal.has(task.state)) ack(task);
    modal.querySelectorAll("[data-task-select]").forEach((tabBtn) => {
      tabBtn.onclick = () => {
        const nextId = tabBtn.getAttribute("data-task-select");
        if (nextId && nextId !== state.dialogTask) {
          state.dialogTask = nextId;
          delete modal.dataset.signature;
          renderDialog();
        }
      };
    });
    const closeButtons = modal.querySelectorAll("[data-task-continue]");
    closeButtons.forEach((button) => { button.onclick = closeDialog; });
    const cancelButton = modal.querySelector("[data-task-cancel]");
    if (cancelButton) cancelButton.onclick = () => cancel(task);
    const settingsButton = modal.querySelector("[data-task-settings]");
    if (settingsButton) settingsButton.onclick = () => {
      closeDialog();
      if (PR.openSettings) PR.openSettings("chat");
      else location.href = "/settings";
    };
    const viewButton = modal.querySelector("[data-task-view]");
    if (viewButton) viewButton.onclick = () => {
      ack(task);
      closeDialog();
      if (isMindmap && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
        PR.emit("open-research-mindmap", { task });
      } else if (isSmartAnnotate && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
        PR.emit("open-smart-annotations", { task });
      } else if (isDeepAnalysis && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
        PR.emit("open-research-deep-analysis", { task });
      } else {
        location.href = resultUrl(task);
      }
    };
    const retryButton = modal.querySelector("[data-task-retry]");
    if (retryButton) retryButton.onclick = () => {
      ack(task);
      closeDialog();
      if (isMindmap && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
        PR.emit("retry-research-mindmap", { task });
      } else if (isSmartAnnotate && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
        PR.emit("retry-smart-annotations", { task });
      } else if (isDeepAnalysis && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
        PR.emit("retry-research-deep-analysis", { task });
      } else {
        location.href = resultUrl(task, true);
      }
    };
    const focusTarget = (focusedAction && modal.querySelector("[data-task-" + focusedAction + "]"))
      || modal.querySelector("[data-task-view], [data-task-retry], [data-task-continue]") || modal;
    if (!wasVisible || focusedAction) focusTarget.focus?.();
  }
  function show(task) {
    if (!task) return;
    if (!state.dialogOpen) state.returnFocus = document.activeElement;
    state.dialogTask = task.id;
    renderDialog();
  }
  function render() {
    let widget = PR.$("#pr-research-task-entry");
    if (!widget) { widget = PR.el("div", { id: "pr-research-task-entry", class: "pr-task-entry" }); document.body.appendChild(widget); }
    const tasks = taskList();
    const working = tasks.filter(active);
    const unread = tasks.find((task) => terminal.has(task.state) && !task.acknowledged && !acknowledgedIds().has(task.id));
    const current = working[0] || unread;
    widget.hidden = !current;
    if (current) {
      const entryText = working.length > 1
        ? PR.t("{name}等 {n} 項任務進行中", { name: label(current), n: working.length })
        : working.length === 1
          ? PR.t("{name}進行中", { name: label(current) })
          : PR.t("研究分析已完成");
      const countBadge = working.length > 1 ? '<span class="pr-task-entry-count">' + working.length + '</span>' : '';
      widget.innerHTML = '<button type="button" class="pr-task-entry-button" aria-label="' + esc(entryText) + '"><span class="pr-task-entry-dot' + (working.length ? ' is-running' : '') + '"></span><span>' + esc(entryText) + '</span>' + countBadge + '<span class="pr-task-entry-chevron">›</span></button>';
      widget.firstElementChild.onclick = () => show(current);
    }
    if (state.dialogOpen) renderDialog();
  }
  function notifyTerminal(task) {
    if (!terminal.has(task.state) || task.state === "cancelled" || task.acknowledged || acknowledgedIds().has(task.id)) return;
    if (state.dialogOpen && state.dialogTask === task.id) { renderDialog(); return; }
    const completed = task.state === "completed";
    const type = taskType(task);
    const isMindmap = type === "mindmap";
    const isSmartAnnotate = type === "smart-annotate";
    const isDeepAnalysis = type === "deep-analysis";
    const title = completed ? taskCompletedTitle(type) :
      task.state === "interrupted" ? PR.t("分析已中斷") : PR.t("分析未完成");
    const actionLabel = completed ? PR.t("查看結果") : PR.t("返回重試");
    PR.toast(esc(title) + (task.message ? " · " + esc(task.message) : ""), {
      label: actionLabel,
      fn: () => {
        ack(task);
        if (isMindmap && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
          if (completed) {
            PR.emit("open-research-mindmap", { task });
          } else {
            PR.emit("retry-research-mindmap", { task });
          }
        } else if (isSmartAnnotate && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
          if (completed) {
            PR.emit("open-smart-annotations", { task });
          } else {
            PR.emit("retry-smart-annotations", { task });
          }
        } else if (isDeepAnalysis && window.location.pathname.startsWith("/read/") && PR.pid === (task.paper_id || task.key)) {
          if (completed) {
            PR.emit("open-research-deep-analysis", { task });
          } else {
            PR.emit("retry-research-deep-analysis", { task });
          }
        } else {
          location.href = resultUrl(task, !completed);
        }
      }
    }, 9000);
    ack(task);
  }
  function applyMindmap(tasks) {
    const raw = (tasks || []).filter((item) => item.kind === "mindmap")
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))[0] || null;
    const task = normalizeTask(raw);
    if (!task) return;
    const previous = state.mindmap?.state;
    state.mindmap = task;
    if (terminal.has(task.state) && previous && !terminal.has(previous)) notifyTerminal(task);
    else if (terminal.has(task.state) && !task.acknowledged && !acknowledgedIds().has(task.id)) notifyTerminal(task);
  }
  function applyDeepAnalysis(tasks) {
    const raw = (tasks || []).filter((item) => item.kind === "deep-analysis")
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))[0] || null;
    const task = normalizeTask(raw);
    if (!task) return;
    const previous = state.deepAnalysis?.state;
    state.deepAnalysis = task;
    if (terminal.has(task.state) && previous && !terminal.has(previous)) notifyTerminal(task);
    else if (terminal.has(task.state) && !task.acknowledged && !acknowledgedIds().has(task.id)) notifyTerminal(task);
  }
  function applySmartAnnotate(tasks) {
    const raw = (tasks || []).filter((item) => item.kind === "smart-annotate")
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))[0] || null;
    const task = normalizeTask(raw);
    if (!task) return;
    const previous = state.smartAnnotate?.state;
    state.smartAnnotate = task;
    if (terminal.has(task.state) && previous && !terminal.has(previous)) notifyTerminal(task);
    else if (terminal.has(task.state) && !task.acknowledged && !acknowledgedIds().has(task.id)) notifyTerminal(task);
  }
  function applyPath(raw) {
    const task = normalizeTask(raw);
    if (!task) return;
    const previous = state.path?.state;
    state.path = task;
    if (terminal.has(task.state) && previous && !terminal.has(previous)) notifyTerminal(task);
    else if (terminal.has(task.state) && !task.acknowledged && !acknowledgedIds().has(task.id)) notifyTerminal(task);
  }
  function applyComparison(tasks) {
    const raw = (tasks || []).filter((item) => item.kind === "comparison")
      .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))[0] || null;
    const task = normalizeTask(raw);
    if (!task) return;
    const previous = state.comparison?.state;
    state.comparison = task;
    if (terminal.has(task.state) && previous && !terminal.has(previous)) notifyTerminal(task);
    else if (terminal.has(task.state) && !task.acknowledged && !acknowledgedIds().has(task.id)) notifyTerminal(task);
  }
  async function poll() {
    if (state.busy || !PR.token) return schedule();
    state.busy = true;
    try {
      const [monitor, pathState] = await Promise.all([
        PR.api("/api/research/v1/monitor"),
        PR.api(PATH_API + "/current")
      ]);
      state.scope = monitor.scope_id || state.scope;
      const pathTask = pathState.task;
      if (pathTask) {
        if (acknowledgedIds().has(pathTask.id)) pathTask.acknowledged = true;
        applyPath(pathTask);
      }
      applyComparison(monitor.tasks);
      applyMindmap(monitor.tasks);
      applySmartAnnotate(monitor.tasks);
      applyDeepAnalysis(monitor.tasks);
      render();
      PR.emit("research-task-update", { path: state.path, comparison: state.comparison, mindmap: state.mindmap, smartAnnotate: state.smartAnnotate, deepAnalysis: state.deepAnalysis });
    } catch (_) { /* keep the last known state while the local service reconnects */ }
    finally { state.busy = false; schedule(); }
  }
  function schedule() {
    clearTimeout(state.timer);
    if (taskList().some(active)) state.timer = setTimeout(poll, 2000);
  }
  async function init() {
    if (location.protocol !== "http:") return;
    if (!PR.$("#pr-research-task-modal")) {
      const modal = PR.el("div", { id: "pr-research-task-modal", class: "pr-task-modal", hidden: true, tabindex: "-1" });
      document.body.appendChild(modal);
    }
    try {
      const library = await PR.api("/api/library");
      PR.token = library.token;
      await poll();
    } catch (_) { /* page app shows its own connection error */ }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && taskList().some(active)) poll(); });
  document.addEventListener("keydown", (event) => {
    if (!state.dialogOpen) return;
    if (event.key === "Escape") { event.preventDefault(); closeDialog(); return; }
    if (event.key !== "Tab") return;
    const modal = PR.$("#pr-research-task-modal");
    const controls = Array.from(modal?.querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') || []);
    if (!controls.length) { event.preventDefault(); modal?.focus(); return; }
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target.id === "pr-research-task-modal") closeDialog();
  });
  PR.researchTaskMonitor = {
    track(rawTask, open = false) {
      const task = normalizeTask(rawTask);
      if (!task) return;
      if (task.id) state.sessionTaskIds.add(task.id);
      if (task.kind === "reading-path" || task.kind === "path") state.path = task;
      else if (task.kind === "comparison") state.comparison = task;
      else if (task.kind === "mindmap") state.mindmap = task;
      else if (task.kind === "smart-annotate") state.smartAnnotate = task;
      else if (task.kind === "deep-analysis") state.deepAnalysis = task;
      if (open) show(task);
      render(); schedule();
    },
    show,
    poll
  };
  init();
})(window.PR);
