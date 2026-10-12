import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from './uuid';

const real = globalThis.crypto;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('works when crypto.randomUUID is missing (plain-http LAN address)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a) });
    const ids = new Set(Array.from({ length: 200 }, () => uuid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(V4);
  });

  it('uses crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-id' });
    expect(uuid()).toBe('fixed-id');
  });
});
