import type { XYPosition } from '@xyflow/react';
import type { CanvasNode } from './types';

const SLOT_W = 280;
const SLOT_H = 220;

/** Walk a grid outward from `start` until a slot doesn't overlap an existing node's top-left corner region. */
export function findFreeSpot(start: XYPosition, nodes: CanvasNode[]): XYPosition {
  const taken = (p: XYPosition) =>
    nodes.some((n) => Math.abs(n.position.x - p.x) < SLOT_W - 20 && Math.abs(n.position.y - p.y) < SLOT_H - 20);
  for (let ring = 0; ring < 6; ring++) {
    for (let row = 0; row <= ring; row++) {
      for (let col = 0; col <= ring; col++) {
        if (row !== ring && col !== ring) continue;
        const p = { x: start.x + col * SLOT_W, y: start.y + row * SLOT_H };
        if (!taken(p)) return p;
      }
    }
  }
  return { x: start.x + 30, y: start.y + 30 };
}
