/* Geometry operates in the same paragraph-relative coordinates used for ink. */
(function (root) {
  "use strict";
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const move = (s, dx, dy) => ({ ...s, x:s.x+dx, y:s.y+dy });
  const rotate = (s, start, point, center) => ({ ...s, rotation:s.rotation + (Math.atan2(point.y-center.y, point.x-center.x) - Math.atan2(start.y-center.y, start.x-center.x))*180/Math.PI });
  function resize(s, handle, dx, dy, free) {
    const angle=-s.rotation*Math.PI/180, lx=dx*Math.cos(angle)-dy*Math.sin(angle), ly=dx*Math.sin(angle)+dy*Math.cos(angle);
    const hasE=handle.includes("e"), hasW=handle.includes("w");
    const hasS=handle.includes("s"), hasN=handle.includes("n");
    const sx = hasE ? 1 : (hasW ? -1 : 0);
    const sy = hasS ? 1 : (hasN ? -1 : 0);
    const isEdge = (sx === 0 && sy !== 0) || (sy === 0 && sx !== 0);
    let width = sx !== 0 ? clamp(s.width + sx * lx, 10, 1000) : s.width;
    let height = sy !== 0 ? clamp(s.height + sy * ly, 10, 1000) : s.height;
    if (!free && !isEdge) {
      const factor=clamp(1+(sx*lx*s.width+sy*ly*s.height)/(s.width*s.width+s.height*s.height),10/Math.min(s.width,s.height),1000/Math.max(s.width,s.height));
      width=s.width*factor; height=s.height*factor;
    }
    const shiftX=sx*(width-s.width)/2, shiftY=sy*(height-s.height)/2, c=Math.cos(-angle), si=Math.sin(-angle);
    return { ...s, x:s.x+(s.width-width)/2+shiftX*c-shiftY*si, y:s.y+(s.height-height)/2+shiftX*si+shiftY*c, width,height };
  }
  function toolbarPosition(rect, size, viewport) {
    if (rect.bottom <= 0 || rect.top >= viewport.height || rect.right <= 0 || rect.left >= viewport.width) return null;
    const gap=10, margin=8;
    const left=clamp((rect.left+rect.right-size.width)/2, margin, Math.max(margin,viewport.width-size.width-margin));
    const below=rect.bottom+gap, above=rect.top-size.height-gap;
    const top=below+size.height<=viewport.height-margin ? below : (above>=margin ? above : clamp(below,margin,Math.max(margin,viewport.height-size.height-margin)));
    return {left,top};
  }
  const geometry={move,rotate,resize,toolbarPosition};
  if (typeof module !== "undefined" && module.exports) module.exports=geometry;
  if (root.PR) root.PR.stickerGeometry=geometry;
})(typeof window === "undefined" ? globalThis : window);
