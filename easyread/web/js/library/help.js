/* 帮助：快捷键、怎么用。按 ? 打开。 */
(function (PR) {
  "use strict";
  const dlg = PR.$("#textDlg");
  const K = (keys, what) => "<tr><td>" + (keys ? keys.split(" ").map((k) => "<kbd>" + PR.esc(k) + "</kbd>").join(" ") : '<small class="hint">' + PR.t("未设置") + "</small>") + "</td><td>" + what + "</td></tr>";

  PR.openHelp = function () {
    const k = (id, def) => (PR.keysOn ? (PR.keyOf(id) || def || "") : "");
    const pair = (id1, id2, def1, def2) => {
      const k1 = k(id1, def1), k2 = k(id2, def2);
      return [k1, k2].filter(Boolean).join(" ");
    };
    const trio = (id1, id2, id3, def1, def2, def3) => {
      const k1 = k(id1, def1), k2 = k(id2, def2), k3 = k(id3, def3);
      return [k1, k2, k3].filter(Boolean).join(" ");
    };

    const readerKeys = PR.keysOn ? (
      K(pair("next", "prev", "J", "K"), PR.t("下一段 / 上一段")) +
      K(pair("note", "question", "N", "Q"), PR.t("给当前段写笔记 / 提问")) +
      K(k("chat", "A"), PR.t("问 AI（带当前段）")) +
      K(k("edit", "E"), PR.t("改译文")) +
      (PR.keyOf("redo") ? K(PR.keyOf("redo"), PR.t("让模型重译这段")) : "") +
      (PR.keyOf("inkToggle") ? K(PR.keyOf("inkToggle"), PR.t("切換手寫")) : "") +
      (PR.keyOf("inkEraser") ? K(PR.keyOf("inkEraser"), PR.t("切換橡皮擦")) : "") +
      (PR.keyOf("stickerToggle") ? K(PR.keyOf("stickerToggle"), PR.t("貼紙素材庫")) : "") +
      K(k("mode", "B"), PR.t("单语 / 双语")) +
      K(k("pages", "O"), PR.t("原文页面板")) +
      K(k("notes", "M"), PR.t("笔记面板")) +
      K(k("research", "R"), PR.t("研究")) +
      K(k("toc", "T"), PR.t("目录")) +
      K(trio("fontUp", "fontDown", "fontReset", "=", "-", "0"), PR.t("字号大 / 小 / 默认")) +
      K("1 2 3 4", PR.t("选中文字后四色划线"))
    ) : '<tr><td colspan="2"><span class="hint">' + PR.t("快捷键已关闭。") + "</span></td></tr>";

    dlg.querySelector(".dialog").innerHTML =
      '<div class="help-head">' + PR.logo("hero sm") + "<div><h2>PaperRead</h2><div class=\"hint\">" + PR.t("版本 {v} · 本地运行，论文和笔记只存在你的电脑上", { v: PR.esc(PR.lib.version || "") }) + "</div></div></div>" +
      (PR.updatePanel ? PR.updatePanel() : "") +
      '<div class="help-cols"><div><h4>' + PR.t("文献库") + '</h4><table class="keys">' +
      K("/", PR.t("搜索")) + K("J K", PR.t("上下移动")) + K("Enter", PR.t("打开阅读")) + K("S", PR.t("星标")) + K("Ctrl+V", PR.t("粘贴链接直接导入")) + K("?", PR.t("这个帮助")) +
      "</table><h4>" + PR.t("导入") + "</h4><p class=\"hint\">" + PR.t("拖 PDF 进窗口；或填 arXiv 编号、DOI、论文标题、论文网页（arXiv、OpenReview、ACL、NeurIPS、bioRxiv、PMC、期刊页面）或 PDF 直链。找不到公开 PDF 的，下载后拖进来。长论文可以只译正文。") + "</p>" +
      "<h4>" + PR.t("翻译引擎") + "</h4><p class=\"hint\">" + PR.t("本机装了 Claude Code 或 Codex 就能直接用，不用 Key；也可以用 DeepSeek、智谱、通义、Gemini 等 API，或本机 Ollama。在设置里换。") + "</p></div>" +
      '<div><h4>' + PR.t("阅读页") + '</h4><table class="keys">' +
      readerKeys +
      "</table></div></div>" +
      '<div class="actions"><button class="btn" data-close>' + PR.t("关闭") + "</button></div>";
    dlg.classList.add("open");
  };

  PR.on && PR.on("ui-changed", () => {
    if (dlg.classList.contains("open") && dlg.querySelector(".help-head")) PR.openHelp();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "?" || e.target.closest("input, textarea, select, [contenteditable]") || PR.$(".dialog-backdrop.open")) return;
    e.preventDefault();
    PR.openHelp();
  });
})(window.PR);
