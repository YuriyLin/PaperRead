/* Manual crop on the rendered PDF page; saves a normalized rectangle. */
(function (PR) {
  "use strict";
  PR.cropFigure = function (id) {
    const block = PR.blockById[id], pages = PR.state.paper.meta.pages || [];
    if (!block || !pages.length) return;
    if (["queued", "running"].includes((PR.state.job || {}).state)) return PR.toast(PR.t("请等本篇翻译完成后再裁图"));
    const focus = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog-backdrop open crop-backdrop";
    wrap.innerHTML = '<div class="dialog crop-dialog" role="dialog" aria-modal="true" aria-labelledby="cropTitle">' +
      '<h2 id="cropTitle">' + PR.t("重新截取图片") + '</h2><p class="hint">' + PR.t("在原页上拖出图片范围，保存后替换当前图片；题注保持不变。") + '</p>' +
      '<label class="field"><span>' + PR.t("原文页码") + '</span><select class="input" id="cropPage">' + pages.map(p => '<option value="' + p.n + '"' + (p.n === block.page ? ' selected' : '') + '>' + p.n + '</option>').join("") + '</select></label>' +
      '<div class="crop-scroll"><div class="crop-stage"><img draggable="false" alt="' + PR.t("在原页上拖动选择截图范围") + '"><div class="crop-box"></div></div></div>' +
      '<p class="hint crop-status" role="status"></p><div class="actions">' + (block.manual_crop ? '<button class="btn" data-crop="reset">' + PR.t("恢复自动截图") + '</button>' : '') +
      '<button class="btn" data-crop="close">' + PR.t("取消") + '</button><button class="btn primary" data-crop="save">' + PR.t("保存截图") + '</button></div></div>';
    document.body.append(wrap);
    const img = wrap.querySelector("img"), stage = wrap.querySelector(".crop-stage"), mark = wrap.querySelector(".crop-box");
    const select = wrap.querySelector("select"), status = wrap.querySelector(".crop-status"), save = wrap.querySelector('[data-crop="save"]');
    let box = block.abox || block.box || null, start = null, busy = false, loaded = false;
    const draw = () => {
      mark.hidden = !box;
      if (box) Object.assign(mark.style, {left: box[0]*100+'%', top: box[1]*100+'%', width: (box[2]-box[0])*100+'%', height: (box[3]-box[1])*100+'%'});
      save.disabled = busy || !loaded || !box || box[2]-box[0] < .02 || box[3]-box[1] < .02;
    };
    const load = () => {
      loaded = false; draw(); status.textContent = PR.t("正在加载原页…");
      img.src = PR.imageUrl(pages.find(p => p.n === +select.value).img);
    };
    img.onload = () => { loaded = true; status.textContent = PR.t("可以重新拖动选择范围"); draw(); };
    img.onerror = () => { loaded = false; status.textContent = PR.t("原页加载失败，请稍后重试"); draw(); };
    select.onchange = () => { box = null; load(); };
    const point = e => { const r = stage.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX-r.left)/r.width)), Math.max(0, Math.min(1, (e.clientY-r.top)/r.height))]; };
    stage.onpointerdown = e => { if (busy || !loaded || e.button !== 0) return; e.preventDefault(); start = point(e); stage.setPointerCapture(e.pointerId); box = [...start, ...start]; draw(); };
    stage.onpointermove = e => { if (!start) return; const end = point(e); box = [Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])]; draw(); };
    stage.onpointerup = stage.onpointercancel = () => { start = null; };
    const close = () => { if (busy) return; wrap.remove(); document.removeEventListener("keydown", key, true); focus?.focus(); };
    const key = e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      if (e.key === "Tab") {
        const list = [...wrap.querySelectorAll('button:not(:disabled),select:not(:disabled)')];
        const next = list[(list.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + list.length) % list.length];
        if (next) { e.preventDefault(); next.focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    wrap.onclick = async e => {
      const action = e.target.closest("[data-crop]")?.dataset.crop;
      if (action === "close") return close();
      if (!action || busy || (action === "save" && save.disabled)) return;
      busy = true; draw(); select.disabled = true; status.textContent = PR.t("正在保存…");
      try {
        await PR.api('/api/p/' + PR.pid + '/figure-crop', {method:'POST', body:{id, page:+select.value, box, reset:action === 'reset'}});
        busy = false; close(); await PR.poll(); PR.toast(PR.t("截图已更新"));
      } catch (err) { busy = false; select.disabled = false; draw(); status.textContent = err.message; }
    };
    load(); select.focus();
  };
})(window.PR);
