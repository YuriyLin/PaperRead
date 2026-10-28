(function (PR) {
  "use strict";
  PR.exportChatMarkdown = async function (thread, id, button) {
    if (button && button.disabled) return;
    if (button) button.disabled = true;
    try {
      const result = await PR.api('/api/p/' + PR.pid + '/chat-export', { method: 'POST', body: { thread, id } });
      const isZip = String(result.filename || "").toLowerCase().endsWith('.zip');
      const filters = [{
        name: isZip ? PR.t("ZIP 壓縮檔") : PR.t("Markdown 文件"),
        extensions: [isZip ? 'zip' : 'md'],
        mime: result.mime || (isZip ? 'application/zip' : 'text/markdown;charset=utf-8')
      }];
      if (typeof PR.saveBase64 === "function") {
        await PR.saveBase64(result.filename, result.data, filters);
      } else {
        const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: result.mime || "application/octet-stream" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      PR.toast(PR.t("已匯出：{name}", { name: result.filename }));
    } catch (err) {
      PR.toast(PR.t("匯出失敗：{msg}", { msg: err.message }));
    } finally {
      if (button) button.disabled = false;
    }
  };
  function shortTitle(value, fallback) {
    let name = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim();
    if (name.length > 80) name = (name.slice(0, 80).replace(/\s+\S*$/, "").trim() || name.slice(0, 80)).trim();
    return name.replace(/[ .-]+$/, "") || fallback;
  }

  PR.exportChatObsidian = async function (thread, id, button) {
    if (button && button.disabled) return;
    const label = button ? button.innerHTML : "";
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="spin"></i> ' + PR.t("正在匯出…");
    }
    try {
      const status = await PR.api("/api/research/v1/status");
      if (!status.configured) {
        const path = window.easyreadDesktop && typeof window.easyreadDesktop.pickFolder === "function"
          ? await window.easyreadDesktop.pickFolder()
          : (await PR.api("/api/library/pick-folder", { method: "POST", body: {} })).path || "";
        if (!path) return;
        await PR.api("/api/research/v1/setup", { method: "POST", body: { vault: path } });
        PR.toast(PR.t("已連結 Obsidian Vault。"));
      }

      const result = await PR.api('/api/p/' + PR.pid + '/chat-export', { method: 'POST', body: { thread, id } });
      const m = (PR.state && PR.state.paper && PR.state.paper.meta) || {};
      const paperName = shortTitle(m.title_zh || m.title_en || result.paper_title || PR.t("論文"), "PaperRead");
      const subfolder = paperName + "/" + PR.t("單則回答");
      const docId = "paper:" + PR.pid + ":chat:" + id;
      const analysisId = "paper:" + PR.pid + ":analysis";

      const doc = {
        id: docId,
        kind: "annotations",
        paper_id: PR.pid,
        title: result.subject || result.stem || PR.t("單則回答"),
        filename: shortTitle(result.stem || result.subject || PR.t("AI回答"), PR.t("AI回答")),
        subfolder: subfolder,
        body: result.markdown || "",
        attachments: result.attachments || [],
        links: [analysisId]
      };

      const exportResult = await PR.api("/api/research/v2/export/obsidian", {
        method: "POST",
        body: { documents: [doc] }
      });

      if (exportResult.conflicts?.length) {
        throw new Error(PR.t("有檔案未能安全更新，請先檢查衝突。"));
      }
      PR.toast(PR.t("已匯出單則回答至 Obsidian Vault。"));
    } catch (err) {
      PR.toast(PR.t("匯出失敗：{msg}", { msg: err.message }));
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = label;
      }
    }
  };
})(window.PR);
