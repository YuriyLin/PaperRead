/* PaperRead reading-path map: fixed layout, SVG edges, and pan/zoom helpers. */
(function (global) {
  "use strict";
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const shortTitle = (title) => String(title || "").trim();

  function layout(steps) {
    const nodeWidth = 218, nodeHeight = 132, gap = 74;
    const rows = [62, 270, 154, 362];
    const positions = new Map();
    steps.forEach((step, index) => {
      positions.set(String(step.paper_key || ""), {
        x: 42 + index * (nodeWidth + gap), y: rows[index % rows.length], width: nodeWidth, height: nodeHeight, index
      });
    });
    return { positions, width: Math.max(760, steps.length * (nodeWidth + gap) + 84), height: 560 };
  }

  function edgePath(source, target) {
    const dx = target.x + target.width / 2 - (source.x + source.width / 2);
    const dy = target.y + target.height / 2 - (source.y + source.height / 2);
    const horizontal = Math.abs(dx) / Math.max(source.width, target.width) >= Math.abs(dy) / Math.max(source.height, target.height);
    const sourceNormal = horizontal ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
    const targetNormal = { x: -sourceNormal.x, y: -sourceNormal.y };
    const anchor = (box, towardX, towardY) => {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const scale = 1 / Math.max(Math.abs(towardX) / (box.width / 2), Math.abs(towardY) / (box.height / 2));
      return { x: cx + towardX * scale, y: cy + towardY * scale };
    };
    const start = anchor(source, dx, dy), end = anchor(target, -dx, -dy);
    end.x -= sourceNormal.x; end.y -= sourceNormal.y;
    const approach = { x: end.x - sourceNormal.x * 10, y: end.y - sourceNormal.y * 10 };
    const pull = Math.max(32, Math.min(100, Math.hypot(end.x - start.x, end.y - start.y) * 0.34));
    const c1 = { x: start.x + sourceNormal.x * pull, y: start.y + sourceNormal.y * pull };
    const c2 = { x: approach.x + targetNormal.x * pull, y: approach.y + targetNormal.y * pull };
    return "M " + start.x + " " + start.y + " C " + c1.x + " " + c1.y + ", " + c2.x + " " + c2.y + ", " + approach.x + " " + approach.y + " L " + end.x + " " + end.y;
  }

  function render(options) {
    const steps = options.steps || [];
    const esc = options.esc || ((value) => String(value || ""));
    const labels = options.labels || {};
    const selectedKey = String(options.selectedKey || "");
    const data = layout(steps);
    const selectedLinks = new Set();
    (options.relations || []).forEach((relation) => {
      if (relation.source === selectedKey || relation.target === selectedKey) selectedLinks.add(relation.source + "|" + relation.target);
    });
    const sequence = (options.showSequence ? steps.slice(0, -1).map((step, index) => {
      const source = data.positions.get(String(step.paper_key || ""));
      const target = data.positions.get(String(steps[index + 1].paper_key || ""));
      return source && target ? '<path class="rw-path-edge rw-path-edge-sequence' + (selectedKey && step.paper_key !== selectedKey && steps[index + 1].paper_key !== selectedKey ? ' is-dim' : '') + '" data-from="' + source.index + '" data-to="' + target.index + '" d="' + edgePath(source, target) + '" marker-end="url(#rw-path-arrow-sequence)"></path>' : "";
    }).join("") : "");
    const citations = (options.showRelations ? (options.relations || []).map((relation) => {
      const source = data.positions.get(String(relation.source || ""));
      const target = data.positions.get(String(relation.target || ""));
      if (!source || !target || relation.source === relation.target) return "";
      const key = relation.source + "|" + relation.target;
      return '<path class="rw-path-edge rw-path-edge-citation' + (selectedKey && !selectedLinks.has(key) ? ' is-dim' : '') + '" data-from="' + source.index + '" data-to="' + target.index + '" d="' + edgePath(source, target) + '" marker-end="url(#rw-path-arrow-citation)"></path>';
    }).join(" ") : "");
    const nodes = steps.map((step, index) => {
      const paper = step.paper || {};
      const key = String(step.paper_key || "");
      const position = data.positions.get(key);
      const state = options.libraryFor ? options.libraryFor(paper) : null;
      const flags = (paper.is_start_paper ? '<span class="rw-path-node-start">' + esc(labels.start || "") + '</span>' : "") +
        (state ? '<span class="rw-path-node-state">' + esc(state) + '</span>' : "");
      const aria = (labels.paper || "") + " " + (index + 1) + ": " + shortTitle(paper.title);
      const roleText = options.translate ? options.translate(step.role) : step.role;
      return '<button type="button" class="rw-path-node' + (key === selectedKey ? ' is-selected' : '') + (paper.is_start_paper ? ' is-start' : '') + '" data-action="path-select-paper" data-path-key="' + esc(key) + '" aria-label="' + esc(aria) + '" aria-pressed="' + (key === selectedKey) + '" style="--node-x:' + position.x + 'px;--node-y:' + position.y + 'px"><span class="rw-path-node-number">' + (index + 1) + '</span><span class="rw-path-node-title">' + (options.titleHtml ? options.titleHtml(shortTitle(paper.title)) : esc(shortTitle(paper.title))) + '</span><span class="rw-path-node-meta">' + esc([paper.year, roleText].filter(Boolean).join(" · ")) + '</span>' + flags + '</button>';
    }).join("");
    return '<div class="rw-path-map-frame"><div class="rw-path-map-stage" tabindex="0" role="region" aria-label="' + esc(labels.mapLabel || "") + '" aria-describedby="rw-path-map-help"><div class="rw-path-map-canvas" style="--map-width:' + data.width + 'px;--map-height:' + data.height + 'px;transform:translate(' + Number(options.view?.panX || 0) + 'px,' + Number(options.view?.panY || 0) + 'px) scale(' + Number(options.view?.scale || 1) + ')"><svg class="rw-path-edges" width="' + data.width + '" height="' + data.height + '" viewBox="0 0 ' + data.width + ' ' + data.height + '" aria-hidden="true"><defs><marker id="rw-path-arrow-sequence" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" viewBox="0 0 12 12" refX="10" refY="6" orient="auto"><path d="M 2 2 L 10 6 L 2 10 z"></path></marker><marker id="rw-path-arrow-citation" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" viewBox="0 0 12 12" refX="10" refY="6" orient="auto"><path d="M 2 2 L 10 6 L 2 10 z"></path></marker></defs>' + sequence + citations + '</svg>' + nodes + '</div></div><p id="rw-path-map-help" class="rw-sr-only">' + esc(labels.mapHelp || "") + '</p></div>';
  }

  function bind(host, view, onChange) {
    const stage = host.querySelector(".rw-path-map-stage");
    const canvas = host.querySelector(".rw-path-map-canvas");
    if (!stage || !canvas) return;
    const boxes = [...canvas.querySelectorAll(".rw-path-node")].map((node) => ({
      x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight
    }));
    canvas.querySelectorAll(".rw-path-edge").forEach((edge) => {
      const source = boxes[Number(edge.dataset.from)], target = boxes[Number(edge.dataset.to)];
      if (!source || !target) return;
      edge.setAttribute("d", edgePath(source, target));
      if (edge.classList.contains("rw-path-edge-sequence")) {
        edge.style.strokeDashoffset = String(5 - edge.getTotalLength() % 14);
      }
    });
    let current = { scale: Number(view?.scale || 1), panX: Number(view?.panX || 0), panY: Number(view?.panY || 0) };
    let drag = null;
    const apply = () => { canvas.style.transform = "translate(" + current.panX + "px," + current.panY + "px) scale(" + current.scale + ")"; };
    const finish = () => { if (drag) { drag = null; onChange({ ...current }); } };
    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".rw-path-node")) return;
      drag = { x: event.clientX, y: event.clientY, panX: current.panX, panY: current.panY };
      stage.setPointerCapture?.(event.pointerId);
      stage.classList.add("is-panning");
    });
    stage.addEventListener("pointermove", (event) => {
      if (!drag) return;
      current.panX = drag.panX + event.clientX - drag.x;
      current.panY = drag.panY + event.clientY - drag.y;
      apply();
    });
    stage.addEventListener("pointerup", () => { stage.classList.remove("is-panning"); finish(); });
    stage.addEventListener("pointercancel", () => { stage.classList.remove("is-panning"); finish(); });
    stage.addEventListener("keydown", (event) => {
      const amount = event.shiftKey ? 56 : 24;
      if (event.key === "ArrowLeft") current.panX += amount;
      else if (event.key === "ArrowRight") current.panX -= amount;
      else if (event.key === "ArrowUp") current.panY += amount;
      else if (event.key === "ArrowDown") current.panY -= amount;
      else return;
      event.preventDefault(); apply(); onChange({ ...current });
    });
  }

  global.PRPathMap = { render, bind, clamp, edgePath };
})(window);
