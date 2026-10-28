/* 回收站：侧栏最下面的“回收站”（有东西时才出现），点开列出删掉的论文，可以恢复、彻底删除、清空。 */
(function (PR) {
  "use strict";
  const L = PR.lib;
  const dlg = () => PR.$("#trashDlg");
  let items = [];

  async function open() {
    items = (await PR.api("/api/trash")).items;
    render();
    dlg().classList.add("open");
  }

  function render() {
    const rows = items.map((t) => {
      const summary = t.type === "summary", title = summary ? (t.paper?.title || PR.t("未命名论文")) : PR.titles(t).main;
      const sub = summary ? [t.paper?.authors, t.paper?.year, t.paper?.venue, PR.t("已整理摘要")].filter(Boolean).join(" · ") : PR.titles(t).sub;
      return '<div class="trash-row"><div class="trash-t"><b>' + (PR.titleHtml ? PR.titleHtml(title) : PR.esc(title)) + "</b>" +
        "<small>" + PR.esc([sub, PR.t("删除于 {t}", { t: PR.shortTime(t.deleted) })].filter(Boolean).join(" · ")) + "</small></div>" +
        '<button class="btn sm" data-tr="restore" data-type="' + (summary ? "summary" : "paper") + '" data-name="' + PR.esc(t.name) + '">' + PR.t("恢复") + "</button>" +
        '<button class="btn sm danger" data-tr="purge" data-type="' + (summary ? "summary" : "paper") + '" data-name="' + PR.esc(t.name) + '">' + PR.t("彻底删除") + "</button></div>";
    }).join("");
    dlg().querySelector(".dialog").innerHTML = "<h2>" + PR.t("回收站") + "</h2>" +
      (items.length ? '<div class="trash-list">' + rows + "</div>" : '<p class="hint">' + PR.t("回收站是空的。") + "</p>") +
      '<div class="actions">' + (items.length ? '<button class="btn danger" data-tr="empty">' + PR.t("清空回收站") + "</button>" : "") +
      '<span class="grow"></span><button class="btn" data-tr="close">' + PR.t("关闭") + "</button></div>";
  }

  async function act(action, name, at, type = "paper") {
    if (action === "purge") {
      const summary = type === "summary";
      if (!(await PR.confirm({ title: summary ? PR.t("彻底删除这份摘要？") : PR.t("彻底删除这篇？"), body: summary ? PR.t("这份摘要会从回收站永久删除，无法恢复。") : PR.t("论文、译文、笔记都会删掉，不能恢复。"), ok: PR.t("彻底删除"), danger: true, at }))) return;
    }
    if (action === "empty" && !(await PR.confirm({ title: PR.t("清空回收站？"), body: PR.t("{n} 个项目会被永久删除，无法恢复。", { n: items.length }), ok: PR.t("清空"), danger: true, at }))) return;
    try {
      await PR.api("/api/trash", { method: "POST", body: { action, name, type } });
    } catch (e) { return PR.toast(PR.esc(e.message)); }
    items = action === "empty" ? [] : items.filter((t) => t.name !== name);
    render();
    await L.load();
    if (action === "restore") PR.toast(type === "summary" ? PR.t("已还原摘要") : PR.t("已恢复"));
  }
  PR.restoreTrash = (name) => act("restore", name);

  dlg().addEventListener("click", (e) => {
    if (e.target === dlg()) return dlg().classList.remove("open");
    const b = e.target.closest("[data-tr]");
    if (!b) return;
    if (b.dataset.tr === "close") return dlg().classList.remove("open");
    act(b.dataset.tr, b.dataset.name, b, b.dataset.type || "paper");
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dlg().classList.contains("open")) dlg().classList.remove("open"); });
  PR.$("#side").addEventListener("click", (e) => { if (e.target.closest("[data-trash]")) open(); });
})(window.PR);
