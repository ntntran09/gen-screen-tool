import { describe, expect, it } from 'vitest';
import { getDefinition, isPortRequired } from './registry';

describe('required ports', () => {
  const generate = getDefinition('generate');
  const port = (id: string) => generate.inputs.find((p) => p.id === id)!;

  it('Prompt is always required on a Generate node', () => {
    expect(isPortRequired(port('prompt'), { mode: 'manual' })).toBe(true);
    expect(isPortRequired(port('prompt'), { mode: 'match' })).toBe(true);
  });

  it('Original is required only when the node cannot run without one', () => {
    expect(isPortRequired(port('original'), { mode: 'manual' })).toBe(false);
    expect(isPortRequired(port('original'), { mode: 'manual' }, { needsOriginal: true })).toBe(true);
  });

  it('Reference, Theme and Palette are optional', () => {
    for (const id of ['reference', 'theme', 'palette']) expect(isPortRequired(port(id), { mode: 'match' })).toBe(false);
  });

  it('no other node has a required input', () => {
    for (const kind of ['palette', 'collection', 'output'] as const) {
      expect(getDefinition(kind).inputs.some((p) => isPortRequired(p, {}))).toBe(false);
    }
  });
});
