export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Box {
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
}

const DEFAULT_W = 320;
const DEFAULT_H = 240;
/** Nodes closer than this (edge to edge, canvas units) belong to the same cluster. */
const LINK_GAP = 1500;

/**
 * Bounds of the largest group of nearby nodes. A stray node dragged far away must not decide where
 * a new tab opens, so the view fits this cluster instead of every node. Null for an empty canvas.
 */
export function mainClusterBounds(nodes: Box[], gap = LINK_GAP): Bounds | null {
  if (!nodes.length) return null;
  const boxes = nodes.map((n) => ({
    x: n.position.x,
    y: n.position.y,
    r: n.position.x + (n.width ?? DEFAULT_W),
    b: n.position.y + (n.height ?? DEFAULT_H),
  }));
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const c = boxes[j];
      if (a.x - gap <= c.r && c.x - gap <= a.r && a.y - gap <= c.b && c.y - gap <= a.b) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  const x = Math.min(...best.map((i) => boxes[i].x));
  const y = Math.min(...best.map((i) => boxes[i].y));
  return { x, y, width: Math.max(...best.map((i) => boxes[i].r)) - x, height: Math.max(...best.map((i) => boxes[i].b)) - y };
}
