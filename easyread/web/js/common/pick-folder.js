/* 选一个文件夹：桌面版用系统窗口；浏览器版让后端弹系统窗口，弹不出来才让人填路径。
   PR.pickFolder({title, body}) → Promise<路径 | null> */
(function (PR) {
  "use strict";
  PR.pickFolder = async function (o = {}) {
    const desktop = window.easyreadDesktop;
    if (desktop && desktop.pickFolder) return (await desktop.pickFolder()) || null;
    const r = await PR.api("/api/library/pick-folder", { method: "POST", body: { title: o.title || "" } }).catch(() => ({ supported: false }));
    if (r.supported) return r.path || null;
    return PR.promptText({ title: o.title || "", body: o.body || PR.t("填写文件夹的完整路径。"), max: 4096, center: true });
  };
})(window.PR);
