/* 页面内的确认框和输入框，代替浏览器自带的 confirm() / prompt()（那种灰框太丑，也不跟主题）。
   PR.confirm({title, body, ok, danger, at}) → Promise<boolean>
     再给 alt（第三个按钮的字）时，点它得到 "alt"；center: true 一定放在屏幕中间。
   PR.promptText({title, value, placeholder, ok, at}) → Promise<string|null>
   at：贴着哪个元素或哪个点弹出；不给就用刚才菜单弹出的位置，再没有就放在屏幕中间。
   Enter 确定，Esc 或点外面取消。 */
(function (PR) {
  "use strict";
  let cur = null;

  function close(v) {
    if (!cur) return;
    const { box, done, onKey, onDown } = cur;
    cur = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    box.classList.remove("open");
    setTimeout(() => box.remove(), 150);
    done(v);
  }

  function place(box, at) {
    const r = at && at.getBoundingClientRect ? at.getBoundingClientRect() : at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : null;
    const w = box.offsetWidth, h = box.offsetHeight;
    if (!r) { box.style.left = Math.max(8, (innerWidth - w) / 2) + "px"; box.style.top = Math.max(8, (innerHeight - h) / 2) + "px"; return; }
    let y = r.bottom + 6;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    box.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
    box.style.top = y + "px";
  }

  function open(o, withInput) {
    close(withInput ? null : false);
    return new Promise((done) => {
      const box = PR.el("div", { class: "popover confirm", role: "dialog" },
        '<div class="cf-title">' + PR.esc(o.title || "") + "</div>" +
        (o.body ? '<div class="cf-body">' + PR.esc(o.body) + "</div>" : "") +
        (withInput ? '<input class="input cf-input" maxlength="' + (o.max || 60) + '" placeholder="' + PR.esc(o.placeholder || "") + '">' : "") +
        '<div class="cf-acts"><button class="btn sm" data-cf="no">' + PR.t("取消") + '</button>' +
        (o.alt && !withInput ? '<button class="btn sm line" data-cf="alt">' + PR.esc(o.alt) + "</button>" : "") + '<button class="btn sm ' + (o.danger ? "danger-fill" : "accent") + '" data-cf="ok">' + PR.esc(o.ok || PR.t("确定")) + "</button></div>");
      document.body.appendChild(box);
      const inp = box.querySelector(".cf-input");
      if (inp) inp.value = o.value || "";
      place(box, o.center ? null : o.at || PR.lastMenuAt);
      requestAnimationFrame(() => box.classList.add("open"));
      const result = (ok) => (withInput ? (ok ? inp.value.trim() || null : null) : ok);
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(result(false)); }
        else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(result(true)); }
      };
      const onDown = (e) => { if (!box.contains(e.target)) close(result(false)); };
      box.addEventListener("click", (e) => { const b = e.target.closest("[data-cf]"); if (b) close(b.dataset.cf === "alt" ? "alt" : result(b.dataset.cf === "ok")); });
      cur = { box, done, onKey, onDown };
      document.addEventListener("keydown", onKey, true);
      setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
      (inp || box.querySelector('[data-cf="ok"]')).focus();
      if (inp) inp.select();
    });
  }

  PR.confirm = (o) => open(o, false);
  PR.promptText = (o) => open(o, true);
})(window.PR);
