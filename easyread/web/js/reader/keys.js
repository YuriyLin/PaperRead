/* 阅读页快捷键的执行。键位、总开关和功能开关在 common/features.js，改键在“设置 → 快捷键”。
   选中文字后的 1–4 划线、N 笔记、Q 提问，和 Esc 关闭，只受总开关控制。 */
(function (PR) {
  "use strict";
  PR.runAction = function (id) {
    const g = {
      mode: () => PR.setPref("mode", PR.prefs.mode === "bi" ? "zh" : "bi"),
      toc: () => PR.toggleDrawer(null, "toc"),
      fontUp: () => PR.bumpFont(1), fontDown: () => PR.bumpFont(-1), fontReset: () => PR.resetType(),
      pages: () => PR.togglePages(), notes: () => PR.toggleNotesPanel(),
      research: () => PR.store.mode === "server" && PR.toggleResearch(),
      inkToggle: () => PR.toggleInk && PR.toggleInk(), inkEraser: () => PR.toggleInkEraser && PR.toggleInkEraser(),
      stickerToggle: () => PR.toggleStickerPanel && PR.toggleStickerPanel(),
      chat: () => { const b = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock(); PR.blockById[b] ? PR.chatAsk({ anchor: b }) : PR.toggleChat(); },
      pagePrev: () => PR.pageStep(-1), pageNext: () => PR.pageStep(1),
    }[id];
    if (g) { g(); return true; }
    return PR.blockAction(id);
  };
})(window.PR);
