// Shared canvas helpers. Theme colors are read once and cached (getComputedStyle per draw call
// was the main CPU cost), and canvases are only resized when their on-screen size changes.
const cache = new Map();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => cache.clear());
export const css = (n) => {
  let v = cache.get(n);
  if (v === undefined) { v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); cache.set(n, v); }
  return v;
};
/** Prepare a canvas for drawing in CSS pixels. Returns { ctx, W, H } or null when it's not visible. */
export function fit(cv) {
  const r = cv.getBoundingClientRect(); if (!r.width || !r.height) return null;
  const dpr = devicePixelRatio || 1, w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, W: r.width, H: r.height };
}
