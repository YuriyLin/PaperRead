/* Freehand selection works in viewport coordinates, independent of page zoom. */
(function (root) {
  "use strict";
  function contains(points, point) {
    if (!Array.isArray(points) || points.length < 3) return false;
    let inside=false;
    for (let i=0,j=points.length-1;i<points.length;j=i++) {
      const a=points[i], b=points[j];
      if ((a.y>point.y)!==(b.y>point.y) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
    }
    return inside;
  }
  function hits(points, rects) {
    return rects.filter(({rect}) => {
      const samples=[{x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2},{x:rect.left,y:rect.top},{x:rect.right,y:rect.top},{x:rect.left,y:rect.bottom},{x:rect.right,y:rect.bottom}];
      return samples.some(point=>contains(points,point));
    });
  }
  function hitsPath(points, path) {
    const rect=path?.getBoundingClientRect?.();
    if (!rect) return false;
    if (hits(points,[{rect}]).length) return true;
    const length=path.getTotalLength?.(), matrix=path.getScreenCTM?.();
    if (!Number.isFinite(length) || !matrix || !path.getPointAtLength) return false;
    const steps=Math.max(1,Math.min(200,Math.ceil(length/8)));
    for (let i=0;i<=steps;i++) {
      const point=path.getPointAtLength(length*i/steps);
      if (contains(points,{x:matrix.a*point.x+matrix.c*point.y+matrix.e,y:matrix.b*point.x+matrix.d*point.y+matrix.f})) return true;
    }
    return false;
  }
  const lasso={contains,hits,hitsPath};
  if (typeof module !== "undefined" && module.exports) module.exports=lasso;
  if (root.PR) root.PR.stickerLasso=lasso;
})(typeof window === "undefined" ? globalThis : window);
