import { describe, expect, it } from 'vitest';
import { mainClusterBounds } from './mainCluster';

const at = (x: number, y: number) => ({ position: { x, y }, width: 100, height: 100 });

describe('mainClusterBounds', () => {
  it('is null for an empty canvas', () => {
    expect(mainClusterBounds([])).toBeNull();
  });

  it('ignores far-away strays and fits the largest group', () => {
    const nodes = [at(1500, 0), at(2800, 400), at(3800, 800), at(-32000, -4800), at(-32100, -4700), at(65000, 21000)];
    expect(mainClusterBounds(nodes)).toEqual({ x: 1500, y: 0, width: 2400, height: 900 });
  });

  it('includes every node when they are all close together', () => {
    expect(mainClusterBounds([at(0, 0), at(500, 500)])).toEqual({ x: 0, y: 0, width: 600, height: 600 });
  });
});
