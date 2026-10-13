import { expect, it } from 'vitest';
import { drawingPath, makeDrawing, stabilizePoint } from './drawing';

it('normalizes reversed and negative strokes without shifting their canvas coordinates', () => {
  const points = [{ x: 10, y: -20 }, { x: -30, y: 50 }, { x: 4, y: 3 }];
  const drawing = makeDrawing(points, 3)!;
  expect(drawing.position).toEqual({ x: -33, y: -23 });
  expect(drawing.canvasWidth).toBe(46);
  expect(drawing.canvasHeight).toBe(76);
  expect(drawing.points.map((p) => ({ x: p.x + drawing.position.x, y: p.y + drawing.position.y }))).toEqual(points);
  expect(drawingPath(drawing.points)).toBe('M43,3 Q3,73 20,49.5 L37,26');
});

it('handles a dot and an empty cancelled stroke', () => {
  expect(makeDrawing([], 3)).toBeNull();
  const dot = makeDrawing([{ x: 0, y: 0 }], 3)!;
  expect([dot.canvasWidth, dot.canvasHeight]).toEqual([6, 6]);
  expect(dot.points).toEqual([{ x: 3, y: 3 }]);
});

it('damps small pen jitter and follows fast strokes more closely', () => {
  const origin = { x: 0, y: 0 };
  const slow = stabilizePoint(origin, { x: 2, y: 0 }, 1);
  const fast = stabilizePoint(origin, { x: 40, y: 0 }, 1);
  expect(slow.x).toBeGreaterThan(0);
  expect(slow.x).toBeLessThan(2);
  expect(fast.x / 40).toBeGreaterThan(slow.x / 2);
  expect(fast.x).toBeLessThan(40);
  expect(stabilizePoint(origin, { x: 4, y: 0 }, 0.5).x * 0.5).toBe(slow.x);
});

it('keeps exact endpoints for dots, straight strokes and curved strokes', () => {
  expect(drawingPath([])).toBe('');
  expect(drawingPath([{ x: 1, y: 2 }])).toBe('M1,2');
  expect(drawingPath([{ x: 1, y: 2 }, { x: 10, y: 20 }])).toBe('M1,2 L10,20');
  const curve = drawingPath([{ x: 1, y: 2 }, { x: 5, y: 15 }, { x: 10, y: 20 }]);
  expect(curve.startsWith('M1,2')).toBe(true);
  expect(curve.endsWith('L10,20')).toBe(true);
});
