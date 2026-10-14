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

export type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const MIN_CROP = 0.005;

/**
 * Move a crop box, or pull one of its edges or corners, by a pointer delta (fractions of the image).
 * The box always stays inside the image and never gets smaller than MIN_CROP.
 */
export function dragBox(origin: CropBox, mode: DragMode, dx: number, dy: number): CropBox {
  if (![dx, dy].every(Number.isFinite)) return origin;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  if (mode === 'move') {
    return { ...origin, x: clamp(origin.x + dx, 0, 1 - origin.w), y: clamp(origin.y + dy, 0, 1 - origin.h) };
  }
  let left = origin.x, right = origin.x + origin.w, top = origin.y, bottom = origin.y + origin.h;
  if (mode.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP);
  if (mode.includes('e')) right = clamp(right + dx, left + MIN_CROP, 1);
  if (mode.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (mode.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  return { x: left, y: top, w: right - left, h: bottom - top };
}
