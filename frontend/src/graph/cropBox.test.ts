import { expect, it } from 'vitest';
import { drawnCrop } from './cropBox';

it('allows reverse drawing and clamps a drag past image edges', () => {
  expect(drawnCrop({ x: 0.8, y: 0.7 }, { x: -0.2, y: 2 })).toEqual({ x: 0, y: 0.7, w: 0.8, h: 1 - 0.7 });
});

it('rejects clicks, zero-width drags, and invalid coordinates', () => {
  expect(drawnCrop({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.2 })).toBeNull();
  expect(drawnCrop({ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.8 })).toBeNull();
  expect(drawnCrop({ x: NaN, y: 0 }, { x: 1, y: 1 })).toBeNull();
});
