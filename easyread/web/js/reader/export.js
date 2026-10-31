/* 匯出筆記：保留單一 Markdown，並提供 Obsidian 多檔案與 ZIP 輸出。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const KINDS = [
    ["paper", PR.t("论文笔记（整篇的感悟）")], ["note", PR.t("我的筆記")], ["highlight", PR.t("我的劃線")], ["question", PR.t("我的問題")],
    ["ai", PR.t("AI 的回答和解释（页边）")], ["chat", PR.t("问 AI 的对话记录")], ["mindmap", PR.t("論文心智圖")],
    ["deep_analysis", PR.t("論文深度剖析")],
    ["quote", PR.t("每条附上原文引用")],
  ];
  const EXPORT_ORDER = ["paper", "note", "highlight", "question", "ai", "chat", "mindmap", "deep_analysis"];

  function counts() {
    const notes = PR.myNotes();
    return {
      paper: (S.reader.paper_note || {}).body ? 1 : 0,
      note: notes.filter((n) => n.kind === "note" || (n.kind !== "question" && n.kind !== "highlight")).length,
      highlight: notes.filter((n) => n.kind === "highlight").length,
      question: notes.filter((n) => n.kind === "question").length,
      ai: (S.discussion.entries || []).length,
    };
  }

  function title() {
    const m = S.paper.meta || {};
    return m.title_zh || m.title_en || PR.t("論文");
  }

  function inkWarning() {
    const count = Object.values(S.reader.ink || {}).filter(stroke => !stroke.deleted).length;
    return count ? PR.t("本次匯出未包含 {n} 筆手寫註記。", { n: count }) : "";
  }

  function shortFilename(value, fallback) {
    let name = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim();
    if (name.length > 80) name = (name.slice(0, 80).replace(/\s+\S*$/, "").trim() || name.slice(0, 80)).trim();
    return name.replace(/[ .-]+$/, "") || fallback;
  }

  function englishTitle() {
    const m = S.paper.meta || {};
    return m.title_en || m.title_zh || PR.t("論文");
  }

  function filenameStem() {
    return shortFilename(englishTitle(), "PaperRead");
  }

  function base64(text) {
    const encode = (value) => {
      if (typeof btoa === "function") return btoa(value);
      if (typeof Buffer === "function") return Buffer.from(value, "binary").toString("base64");
      throw new Error(PR.t("目前環境不支援匯出編碼"));
    };
    if (typeof TextEncoder !== "function") return encode(unescape(encodeURIComponent(String(text))));
    const bytes = new TextEncoder().encode(String(text));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return encode(binary);
  }

  async function saveBase64(filename, contentBase64, filters, textFallback) {
    if (window.easyreadDesktop && typeof window.easyreadDesktop.saveFile === "function") {
      const result = await window.easyreadDesktop.saveFile({ filename, contentBase64: contentBase64 || base64(textFallback || ""), filters });
      return !result || !result.canceled;
    }
    if (textFallback != null && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: filters.map((x) => ({ description: x.name, accept: { [x.mime || "text/plain"]: x.extensions.map((ext) => "." + ext) } })) });
      const stream = await handle.createWritable(); await stream.write(textFallback); await stream.close();
      return true;
    }
    if (textFallback != null) {
      const anchor = PR.el("a", { href: URL.createObjectURL(new Blob([textFallback], { type: filters[0]?.mime || "text/plain" })), download: filename });
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      return true;
    }
    const bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
    const anchor = PR.el("a", { href: URL.createObjectURL(new Blob([bytes], { type: filters[0]?.mime || "application/octet-stream" })), download: filename });
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    return true;
  }
  PR.saveBase64 = saveBase64;

  PR.openExport = function () {
    const c = counts();
    const saved = PR.ls.get("easyread-export", { paper: true, note: true, highlight: true, question: true, ai: true, chat: false, quote: true, mindmap: false, deep_analysis: false });
    const labels = Object.fromEntries(KINDS.map(([key, label]) => [key, label]));
    const dlg = PR.$("#readerDlg");
    const rows = EXPORT_ORDER.map((key) => '<div class="exp-row" data-exp-row="' + key + '"><label><input type="checkbox" data-exp="' + key + '"' + (saved[key] ? " checked" : "") + ">" + labels[key] +
      (c[key] != null ? '<span class="n">' + PR.t("{n} 条", { n: c[key] }) + "</span>" : "") + "</label></div>").join("");
    const quote = KINDS.find(([key]) => key === "quote");
    dlg.querySelector(".dialog").innerHTML = "<h2>" + PR.t("匯出筆記") + "</h2><div class=\"exp-opts\">" + rows +
      '<div class="exp-row exp-quote"><label><input type="checkbox" data-exp="quote"' + (saved.quote ? " checked" : "") + ">" + quote[1] + '</label></div></div><div class="actions"><button class="btn" data-exp-close>' + PR.t("關閉") + '</button><button class="btn" data-exp-download>' + PR.t("下載") + '</button><button class="btn primary" data-exp-vault>' + PR.t("匯出至 Obsidian Vault") + '</button></div>'; /* i18n-dom: shared DOM translator localizes rendered UI text. */
    dlg.classList.add("open");
  };

  async function prepare() {
    const dlg = PR.$("#readerDlg"), pick = {};
    PR.$$('[data-exp]', dlg).forEach((input) => { pick[input.dataset.exp] = input.checked; });
    const order = EXPORT_ORDER;
    PR.ls.set("easyread-export", pick);
    let chat = [];
    if (pick.chat) {
      let data = S.chat || {};
      if (PR.store.mode === "server") data = await PR.api("/api/p/" + PR.pid + "/chat");
      chat = data.threads ? data.threads.flatMap((thread) => thread.messages || []) : data.messages || [];
    }
    let mindmap = "";
    let mindmapPngBase64 = "";
    if (pick.mindmap) {
      const endpoint = "/api/research/v2/paper/" + encodeURIComponent(PR.pid) + "/mindmap";
      let result = await PR.api(endpoint);
      if (!result.mermaid) result = await PR.api(endpoint, { method: "POST", body: {} });
      if (!result.mermaid) throw new Error(PR.t("沒有取得心智圖內容。"));
      mindmap = result.mermaid;
      if (PR.mindmap && typeof PR.mindmap.exportPngBase64 === "function") {
        try {
          mindmapPngBase64 = await PR.mindmap.exportPngBase64(mindmap, { title: title() });
        } catch (e) {
          console.error("[Export] 心智圖 PNG 產生失敗:", e); // i18n-ok
        }
      }
    }
    let deepAnalysis = "";
    if (pick.deep_analysis) {
      const endpoint = "/api/research/v2/paper/" + encodeURIComponent(PR.pid) + "/deep-analysis";
      const result = await PR.api(endpoint);
      deepAnalysis = result?.report?.markdown || "";
      if (!deepAnalysis) throw new Error(PR.t("尚未產生深度剖析報告，請先在「研究脈絡」中產生報告。"));
    }
    const warning = inkWarning();
    const text = PR.notesMarkdown(pick, chat, { order, chat, mindmap, deepAnalysis });
    return { dlg, pick, order, chat, mindmap, mindmapPngBase64, deepAnalysis, text: warning ? warning + "\n\n" + text : text, warning };
  }

  function documents(prepared) {
    const { pick, order, chat, mindmap } = prepared, m = S.paper.meta || {}, paperId = PR.pid;
    const analysisId = "paper:" + paperId + ":analysis", mindmapId = "paper:" + paperId + ":mindmap";
    const notesId = "paper:" + paperId + ":notes", highlightsId = "paper:" + paperId + ":highlights", chatAllId = "paper:" + paperId + ":chat_all";
    const bibliography = ["## 書目資料", "", m.title_en ? "- English title: " + m.title_en : "", m.authors ? "- " + PR.t("作者") + "：" + m.authors : "", m.date ? "- " + PR.t("年份") + "：" + m.date : "", m.doi ? "- DOI: " + m.doi : "", m.url ? "- URL: " + m.url : ""].filter(Boolean).join("\n"); // i18n-ok: exported Markdown content headings are data, not interface copy.
    const note = (S.reader.paper_note || {}).body;
    const analysis = [bibliography, pick.paper && note ? "## " + PR.t("論文筆記") + "\n\n" + note : "", prepared.warning].filter(Boolean).join("\n\n");
    const result = [];
    const stem = filenameStem();
    const paperFolder = shortFilename(m.title_zh || m.title_en || PR.t("論文"), "PaperRead");

    const deepAnalysisId = "paper:" + paperId + ":deep_analysis";

    if (pick.paper) {
      result.push({
        id: analysisId,
        kind: "analysis",
        paper_id: paperId,
        title: title() + " - " + PR.t("論文分析"),
        filename: stem + "-analysis",
        body: analysis,
        links: [mindmapId, deepAnalysisId, notesId, highlightsId, chatAllId],
      });
    }

    if (pick.mindmap && mindmap) {
      const imgName = stem + "-mind-map.png";
      const doc = {
        id: mindmapId,
        kind: "mindmap",
        paper_id: paperId,
        title: title() + " - " + PR.t("心智圖"),
        filename: stem + "-mind-map",
        body: "## " + PR.t("論文心智圖") + "\n\n![[" + imgName + "]]",
        links: [analysisId, notesId],
      };
      if (prepared.mindmapPngBase64) {
        doc.image_base64 = prepared.mindmapPngBase64;
        doc.attachment = {
          filename: imgName,
          content_base64: prepared.mindmapPngBase64,
        };
      }
      result.push(doc);
    }

    if (pick.deep_analysis && prepared.deepAnalysis) {
      result.push({
        id: deepAnalysisId,
        kind: "deep-analysis",
        paper_id: paperId,
        title: title() + " - " + PR.t("深度剖析"),
        filename: stem + "-deep-analysis",
        body: prepared.deepAnalysis,
        links: [analysisId, mindmapId],
      });
    }

    // 03-閱讀標註：依論文建立子資料夾，並區分出「我的筆記」、「我的劃線」、「所有AI問答」
    if (pick.note || pick.question) {
      const myNotes = PR.notesMarkdown({
        paper: false,
        note: !!pick.note,
        question: !!pick.question,
        highlight: false,
        ai: false,
        chat: false,
        quote: !!pick.quote,
      }, [], { order: ["note", "question"], chat: [], mindmap: "" });
      if (myNotes.trim()) {
        result.push({
          id: notesId,
          kind: "annotations",
          paper_id: paperId,
          title: title() + " - " + PR.t("我的筆記"),
          filename: stem + "-notes",
          subfolder: paperFolder + "/" + PR.t("我的筆記"),
          body: myNotes.trim(),
          links: [analysisId, mindmapId, highlightsId],
        });
      }
    }

    if (pick.highlight) {
      const highlights = PR.notesMarkdown({
        paper: false,
        note: false,
        question: false,
        highlight: true,
        ai: false,
        chat: false,
        quote: !!pick.quote,
      }, [], { order: ["highlight"], chat: [], mindmap: "" });
      if (highlights.trim()) {
        result.push({
          id: highlightsId,
          kind: "annotations",
          paper_id: paperId,
          title: title() + " - " + PR.t("我的劃線"),
          filename: stem + "-highlights",
          subfolder: paperFolder + "/" + PR.t("我的劃線"),
          body: highlights.trim(),
          links: [analysisId, notesId],
        });
      }
    }

    if (pick.ai || pick.chat) {
      const allAiQa = PR.notesMarkdown({
        paper: false,
        note: false,
        question: false,
        highlight: false,
        ai: !!pick.ai,
        chat: !!pick.chat,
        quote: !!pick.quote,
      }, chat, { order: ["ai", "chat"], chat, mindmap: "" });
      if (allAiQa.trim()) {
        result.push({
          id: chatAllId,
          kind: "annotations",
          paper_id: paperId,
          title: title() + " - " + PR.t("所有AI問答"),
          filename: stem + "-all-ai-qa",
          subfolder: paperFolder + "/" + PR.t("所有AI問答"),
          body: allAiQa.trim(),
          links: [analysisId, notesId],
        });
      }
    }

    const available = new Set(result.map((item) => item.id));
    result.forEach((item) => { item.links = item.links.filter((target) => available.has(target)); });
    return result;
  }

  async function run(mode, button) {
    if (button.disabled) return;
    const label = button.innerHTML;
    button.disabled = true; button.innerHTML = '<i class="spin"></i> ' + PR.t("正在準備匯出…"); /* i18n-dom: shared DOM translator localizes rendered UI text. */
    try {
      if (mode === "vault") {
        const status = await PR.api("/api/research/v1/status");
        if (!status.configured) {
          const path = window.easyreadDesktop && typeof window.easyreadDesktop.pickFolder === "function"
            ? await window.easyreadDesktop.pickFolder()
            : (await PR.api("/api/library/pick-folder", { method: "POST", body: {} })).path || "";
          if (!path) { button.disabled = false; button.innerHTML = label; return; }
          await PR.api("/api/research/v1/setup", { method: "POST", body: { vault: path } });
          PR.toast(PR.t("已連結 Obsidian Vault。"));
        }
      }
      const prepared = await prepare();
      if (mode === "vault") {
        const result = await PR.api("/api/research/v2/export/obsidian", { method: "POST", body: { documents: documents(prepared) } });
        if (result.conflicts?.length) throw new Error(PR.t("有檔案未能安全更新，請先檢查衝突。"));
        PR.toast(PR.t("已匯出至 Obsidian Vault。"));
      } else if (mode === "zip") {
        const result = await PR.api("/api/research/v2/export/zip", { method: "POST", body: { documents: documents(prepared) } });
        await saveBase64(filenameStem() + "-research.zip", result.content_base64, [{ name: "ZIP", extensions: ["zip"], mime: "application/zip" }]);
      } else {
        const selected = EXPORT_ORDER.filter((key) => prepared.pick[key]);
        if (!selected.length) throw new Error(PR.t("請至少選擇一項匯出內容。"));
        if (selected.length === 1 && selected[0] === "mindmap") {
          if (!prepared.mindmapPngBase64) {
            throw new Error(PR.t("心智圖 PNG 產生失敗，請重試。"));
          }
          await saveBase64(filenameStem() + "-mind-map.png", prepared.mindmapPngBase64, [{ name: "PNG", extensions: ["png"], mime: "image/png" }]);
        } else if (selected.length === 1 && selected[0] === "deep_analysis") {
          await saveBase64(filenameStem() + "-deep-analysis.md", null, [{ name: "Markdown", extensions: ["md"], mime: "text/markdown" }], prepared.deepAnalysis);
        } else if (selected.length === 1) {
          await saveBase64(filenameStem() + "-notes.md", null, [{ name: "Markdown", extensions: ["md"], mime: "text/markdown" }], prepared.text); // i18n-ok: filename suffix is exported data, not UI copy.
        } else {
          const result = await PR.api("/api/research/v2/export/zip", { method: "POST", body: { documents: documents(prepared) } });
          await saveBase64(filenameStem() + "-research.zip", result.content_base64, [{ name: "ZIP", extensions: ["zip"], mime: "application/zip" }]);
        }
      }
      prepared.dlg.classList.remove("open");
    } catch (error) {
      const message = PR.errorText ? PR.errorText(error) : String(error && error.message || error);
      if (PR.toast) PR.toast(PR.t("匯出失敗：{message}", { message: PR.esc ? PR.esc(message) : message }));
      button.disabled = false; button.innerHTML = label;
    }
  }

  PR.$("#readerDlg").addEventListener("click", async (event) => {
    const dlg = PR.$("#readerDlg");
    if (event.target.closest("[data-exp-close]")) return dlg.classList.remove("open");
    const button = event.target.closest("[data-exp-download]") || event.target.closest("[data-exp-vault]");
    if (!button) return;
    const mode = button.hasAttribute?.("data-exp-vault") ? "vault" : "download";
    return run(mode, button);
  });
})(window.PR);
