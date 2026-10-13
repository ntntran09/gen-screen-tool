export interface DrawPoint { x: number; y: number }

/** Store stroke coordinates relative to its node, with room for the round stroke cap. */
export function makeDrawing(points: DrawPoint[], strokeWidth: number) {
  if (!points.length) return null;
  const padding = Math.max(1, strokeWidth);
  const left = Math.min(...points.map((p) => p.x)) - padding;
  const top = Math.min(...points.map((p) => p.y)) - padding;
  const right = Math.max(...points.map((p) => p.x)) + padding;
  const bottom = Math.max(...points.map((p) => p.y)) + padding;
  return { position: { x: left, y: top }, points: points.map((p) => ({ x: p.x - left, y: p.y - top })),
    canvasWidth: Math.max(1, right - left), canvasHeight: Math.max(1, bottom - top) };
}

/** Gentle screen-space filtering: steady small movements, catch up on fast strokes. */
export function stabilizePoint(previous: DrawPoint, next: DrawPoint, zoom: number): DrawPoint {
  const distance = Math.hypot(next.x - previous.x, next.y - previous.y) * zoom;
  const follow = Math.min(0.85, Math.max(0.4, distance / 20));
  return { x: previous.x + (next.x - previous.x) * follow, y: previous.y + (next.y - previous.y) * follow };
}

/** Midpoint curves avoid angular joins without overshooting the stroke's bounds. */
export function drawingPath(points: DrawPoint[]): string {
  if (!points.length) return '';
  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], next = points[i + 1];
    path += ` Q${p.x},${p.y} ${(p.x + next.x) / 2},${(p.y + next.y) / 2}`;
  }
  if (points.length > 1) {
    const last = points[points.length - 1];
    path += ` L${last.x},${last.y}`;
  }
  return path;
}
