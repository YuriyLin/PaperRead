/* The caller supplies an already validated original Lucide SVG. */
(function (root) {
  "use strict";
  function lucideSvg(svg, color, width) {
    if (!/^#[0-9a-f]{6}$/i.test(color) || !Number.isFinite(width) || width < 1 || width > 4) return null;
    return svg.replace(/^(\s*<svg\b)([^>]*>)/, (match, start, attrs) => {
      if (!/\bstroke="currentColor"/.test(attrs) || !/\bstroke-width="2"/.test(attrs) || /\bcolor=/.test(attrs)) return match;
      let nextAttrs = attrs.replace(/\bstroke-width="2"/, 'stroke-width="' + width + '"');
      if (!/\bpreserveAspectRatio=/.test(nextAttrs)) nextAttrs = ' preserveAspectRatio="none"' + nextAttrs;
      return start + ' color="' + color + '"' + nextAttrs;
    });
  }
  if (typeof module !== "undefined" && module.exports) module.exports={lucideSvg};
  if (root.PR) root.PR.stickerStyle={lucideSvg};
})(typeof window === "undefined" ? globalThis : window);
