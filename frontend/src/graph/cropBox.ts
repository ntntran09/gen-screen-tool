export type CropBox = { x: number; y: number; w: number; h: number };

/** Normalize a drawn rectangle; reject clicks and non-finite coordinates. */
export function drawnCrop(start: { x: number; y: number }, end: { x: number; y: number }): CropBox | null {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const x = Math.min(clamp(start.x), clamp(end.x));
  const y = Math.min(clamp(start.y), clamp(end.y));
  const w = Math.abs(clamp(end.x) - clamp(start.x));
  const h = Math.abs(clamp(end.y) - clamp(start.y));
  return w >= 0.001 && h >= 0.001 ? { x, y, w, h } : null;
}
