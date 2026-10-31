(function (root) {
  "use strict";
  function distance(x, y, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
    return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
  }
  function hitPath(path, a, b, radius) {
    const bounds = path.getBoundingClientRect(), pad = radius + (Number(path.getAttribute("stroke-width")) || 0) / 2;
    if (Math.max(a.x,b.x) + pad < bounds.left || Math.min(a.x,b.x) - pad > bounds.right ||
        Math.max(a.y,b.y) + pad < bounds.top || Math.min(a.y,b.y) - pad > bounds.bottom) return false;
    const matrix = path.getScreenCTM();
    if (!matrix) return false;
    const length = path.getTotalLength();
    const scale = Math.max(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));
    if (!Number.isFinite(length) || !Number.isFinite(scale) || scale <= 0) return false;
    const count = Math.max(1, Math.ceil(length * scale / Math.max(1, Math.min(4, pad))));
    for (let i = 0; i <= count; i++) {
      const p = path.getPointAtLength(length * i / count);
      if (distance(matrix.a*p.x + matrix.c*p.y + matrix.e, matrix.b*p.x + matrix.d*p.y + matrix.f, a, b) <= pad) return true;
    }
    return false;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { distance, hitPath };
  else root.PR.inkEraser = { distance, hitPath };
})(typeof window === "undefined" ? globalThis : window);
