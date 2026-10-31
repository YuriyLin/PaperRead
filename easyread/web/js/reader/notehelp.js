/* 论文笔记的 AI 帮手：点评、帮我改、起草稿。结果流到笔记下方的小框里，读者决定替换、追加还是丢掉。
   和“问 AI”分开（不占右侧面板、不进对话记录）；服务端见 notehelp.py。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const NAMES = { review: PR.t("AI 点评"), revise: PR.t("AI 改过的笔记"), draft: PR.t("AI 起的草稿") };
  const ai = { mode: null, text: "", model: "", notice: "", streaming: false, error: "", ctrl: null };
  const noteNow = () => { const ta = PR.$("#paperNote"); return ta ? ta.value : (S.reader.paper_note || {}).body || ""; };

  PR.noteHelpOn = () => PR.store.mode === "server" && PR.feature("chat") && PR.canChat && PR.canChat();

  /* 工具栏上的按钮：笔记空着时只有“起草稿” */
  PR.noteHelpButtons = function () {
    if (!PR.noteHelpOn()) return "";
    const empty = !noteNow().trim();
    const dis = ai.streaming ? " disabled" : "";
    return '<span class="nh-btns">' + (empty ? '<button class="btn sm" data-nh="draft"' + dis + ">" + PR.icon("sparkle", "sm") + PR.t("AI 起个草稿") + "</button>"
      : '<button class="btn sm" data-nh="review"' + dis + ">" + PR.icon("sparkle", "sm") + PR.t("AI 点评") + "</button>" +
        '<button class="btn sm" data-nh="revise"' + dis + ">" + PR.t("AI 帮我改") + "</button>") + "</span>";
  };

  PR.noteHelpBox = function () {
    if (!ai.mode) return "";
    const apply = ai.mode === "review" ? '<button class="btn sm" data-nh="append">' + PR.t("追加到笔记末尾") + "</button>"
      : '<button class="btn sm accent" data-nh="replace">' + PR.t("替换我的笔记") + '</button><button class="btn sm" data-nh="append">' + PR.t("追加到末尾") + "</button>";
    const notice = ai.notice ? '<div class="np-ai-notice"><span class="np-ai-notice-icon">💡</span><span>' + PR.esc(ai.notice) + '</span></div>' : "";
    return '<div class="np-ai"><div class="np-ai-head"><b>' + NAMES[ai.mode] + "</b>" + (ai.model ? "<small>" + PR.esc(ai.model) + "</small>" : "") + '<span class="grow"></span>' +
      (ai.streaming ? '<button class="btn sm" data-nh="stop">' + PR.t("停止") + "</button>" : '<button class="btn icon" data-nh="close" title="' + PR.t("丢掉") + '">×</button>') + "</div>" +
      notice +
      '<div class="np-ai-body">' + (ai.text ? PR.mdBlocks(ai.text) : ai.streaming ? '<p class="hint"><span class="spin"></span> ' + PR.t("正在想…") + "</p>" : "") +
      (ai.error ? '<p class="err">' + PR.esc(ai.error) + "</p>" : "") + "</div>" +
      (!ai.streaming && ai.text ? '<div class="np-ai-acts">' + apply + "</div>" : "") + "</div>";
  };

  const paint = () => { const box = PR.$("#notespanel .np-ai"); if (box) box.outerHTML = PR.noteHelpBox(); else PR.renderNotesPanel(); };
  const paintSoon = PR.debounce(paint, 80);

  function updateTopbarIndicator(running) {
    const btn = PR.$ && PR.$('#bar [data-act="notes"]');
    if (btn) btn.classList.toggle("is-running", !!running);
  }

  function notifyDone(mode) {
    const title = mode === "draft"
      ? PR.t("AI 筆記起草已完成")
      : mode === "review"
        ? PR.t("AI 筆記點評已完成")
        : PR.t("AI 筆記修改已完成");

    PR.toast(PR.esc(title), {
      label: PR.t("查看結果"),
      fn: () => {
        if (PR.openPaperNotes) PR.openPaperNotes();
        setTimeout(() => {
          const box = PR.$ && PR.$("#notespanel .np-ai");
          if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 80);
      }
    }, 6000);

    if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const paperTitle = (S.paper && S.paper.meta && (S.paper.meta.title_zh || S.paper.meta.title_en)) || "";
        const n = new Notification(title, {
          body: paperTitle ? String(paperTitle).slice(0, 80) : PR.t("點擊返回閱讀器查看生成內容"),
          icon: "/web/paperread-mark.png",
        });
        n.onclick = () => {
          window.focus();
          if (PR.openPaperNotes) PR.openPaperNotes();
          n.close();
        };
      } catch (_) {}
    }
  }

  async function run(mode) {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (_) {}
    }
    ai.ctrl && ai.ctrl.abort();
    const note = noteNow();  // 先取再重画：输入框里可能有还没存下的字（自动保存有 0.6 秒延迟）
    if (note !== ((S.reader.paper_note || {}).body || "")) PR.commit({ op: "paper_note", body: note });
    Object.assign(ai, { mode, text: "", model: "", notice: "", streaming: true, error: "", ctrl: new AbortController() });
    PR.renderNotesPanel();
    updateTopbarIndicator(true);
    let aborted = false;
    try {
      const res = await fetch("/api/p/" + PR.pid + "/notehelp", {
        method: "POST", signal: ai.ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ mode, note }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.model) ai.model = ev.model;
          if (ev.notice) ai.notice = ev.notice;
          if (ev.t) { ai.text += ev.t; paintSoon(); }
          if (ev.error) ai.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name === "AbortError") aborted = true;
      else ai.error = PR.t("没能完成：{msg}", { msg: PR.errorText(e) });
    }
    ai.streaming = false; ai.ctrl = null;
    updateTopbarIndicator(false);
    PR.renderNotesPanel();

    if (!aborted) {
      if (ai.error) {
        PR.toast(PR.esc(ai.error), null, 5000);
      } else if (ai.text) {
        notifyDone(mode);
      }
    }
  }

  function setNote(body) {
    PR.commit({ op: "paper_note", body });
    ai.mode = null;
    PR.renderNotesPanel();
  }

  PR.$("#notespanel").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-nh]");
    if (!b) return;
    const act = b.dataset.nh;
    if (NAMES[act]) return run(act);
    if (act === "stop") { ai.ctrl && ai.ctrl.abort(); updateTopbarIndicator(false); return; }
    if (act === "close") { ai.mode = null; return PR.renderNotesPanel(); }
    const cur = noteNow();
    if (act === "append") return setNote((cur.trim() ? cur.replace(/\s+$/, "") + "\n\n" : "") + (ai.mode === "review" ? "**" + PR.t("AI 点评") + "**\n\n" : "") + ai.text.trim());
    if (act === "replace") {
      setNote(ai.text.trim());
      PR.toast(PR.t("已替换论文笔记"), { label: PR.t("撤销"), fn: () => setNote(cur) });
    }
  });
})(window.PR);
