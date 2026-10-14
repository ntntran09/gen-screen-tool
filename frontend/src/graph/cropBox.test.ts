import { expect, it } from 'vitest';
import { dragBox, drawnCrop } from './cropBox';

it('allows reverse drawing and clamps a drag past image edges', () => {
  expect(drawnCrop({ x: 0.8, y: 0.7 }, { x: -0.2, y: 2 })).toEqual({ x: 0, y: 0.7, w: 0.8, h: 1 - 0.7 });
});

it('rejects clicks, zero-width drags, and invalid coordinates', () => {
  expect(drawnCrop({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.2 })).toBeNull();
  expect(drawnCrop({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.8 })).toBeNull();
  expect(drawnCrop({ x: NaN, y: 0 }, { x: 1, y: 1 })).toBeNull();
});

const box = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };

it('moves a box but keeps it inside the image', () => {
  const moved = dragBox(box, 'move', 0.1, -0.1);
  expect(moved.x).toBeCloseTo(0.3);
  expect(moved.y).toBeCloseTo(0.2);
  expect([moved.w, moved.h]).toEqual([0.4, 0.2]);
  expect(dragBox(box, 'move', 5, 5)).toEqual({ x: 0.6, y: 0.8, w: 0.4, h: 0.2 });
  expect(dragBox(box, 'move', -5, -5)).toMatchObject({ x: 0, y: 0 });
});

it('resizes from an edge or a corner and keeps the opposite side fixed', () => {
  const east = dragBox(box, 'e', 0.1, 0.5);
  expect(east.x).toBe(0.2);
  expect(east.w).toBeCloseTo(0.5);
  expect(east.y).toBe(0.3); // an edge does not move the other axis
  const nw = dragBox(box, 'nw', -0.1, -0.1);
  expect(nw.x).toBeCloseTo(0.1);
  expect(nw.y).toBeCloseTo(0.2);
  expect(nw.x + nw.w).toBeCloseTo(0.6);
  expect(nw.y + nw.h).toBeCloseTo(0.5);
});

it('cannot invert the box or leave the image', () => {
  const squeezed = dragBox(box, 'e', -5, 0);
  expect(squeezed.w).toBeGreaterThan(0);
  expect(squeezed.x).toBe(0.2);
  const grown = dragBox(box, 'se', 5, 5);
  expect(grown.x + grown.w).toBe(1);
  expect(grown.y + grown.h).toBe(1);
  expect(dragBox(box, 'move', NaN, 0)).toBe(box);
});
