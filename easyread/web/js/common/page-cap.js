/* 超页数确认：文献库和阅读页共用，确认只对这一篇、这一次任务有效。 */
(function (PR) {
  "use strict";
  const pending = new Set();
  const hasFirstPages = (job) => !Array.isArray(job.pages) || job.pages.some((n) => n <= (job.page_cap || 60));
  PR.pageCapHtml = function (job) {
    if (!job || job.state !== "confirm") return "";
    const cap = job.page_cap || 60;
    const message = job.tables_only ? job.message : job.read ? PR.t("这篇要整理 {n} 页，超过了你设的 {cap} 页，确认后再开始", { n: job.total, cap })
      : PR.t("这篇要译 {n} 页，超过了你设的 {cap} 页，确认后再开始", { n: job.total, cap });
    return '<div class="pending page-cap" role="status"><b>' + PR.t("等你确认") + '</b><p>' + PR.esc(message) + '</p><div class="page-cap-actions">' +
      '<button class="btn sm accent" data-page-cap="all">' + (job.tables_only ? PR.t("全部補譯表格") : job.read ? PR.t("全部整理") : PR.t("全部翻译")) + '</button>' +
      (hasFirstPages(job) ? '<button class="btn sm line" data-page-cap="first">' + (job.tables_only ? PR.t("只補譯前 {cap} 頁的表格", { cap }) : job.read ? PR.t("只整理前 {cap} 页", { cap }) : PR.t("只译前 {cap} 页", { cap })) + '</button>' : '') +
      '<button class="btn sm" data-page-cap="skip">' + (job.read ? PR.t("先不整理") : PR.t("先不译")) + '</button></div></div>';
  };
  PR.handlePageCap = async function (button, id, job, refresh) {
    if (!job || job.state !== "confirm" || pending.has(id)) return;
    const action = button.dataset.pageCap;
    if (!["all", "first", "skip"].includes(action)) return;
    if (action === "first" && !hasFirstPages(job)) return;
    pending.add(id);
    const buttons = button.closest(".page-cap").querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const body = action === "skip" ? {} : { scope: action === "first" ? "range:1-" + (job.page_cap || 60) : job.scope || "all",
        read: !!job.read, model: job.model || null, target: job.target || PR.target };
      if (action !== "skip" && job.tables_only) body.tables_only = true;
      if (action === "all") body.confirmed = true;
      await PR.api("/api/p/" + id + (action === "skip" ? "/cancel" : "/translate"), { method: "POST", body });
      await refresh();
    } catch (error) { PR.toast(PR.esc(error.message)); }
    finally { pending.delete(id); buttons.forEach((b) => { b.disabled = false; }); }
  };
})(window.PR);
