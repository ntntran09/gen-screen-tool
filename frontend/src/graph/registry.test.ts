import { describe, expect, it } from 'vitest';
import { getDefinition, isPortRequired } from './registry';

describe('required ports', () => {
  const generate = getDefinition('generate');
  const port = (id: string) => generate.inputs.find((p) => p.id === id)!;

  it('Prompt is always required on a Generate node', () => {
    expect(isPortRequired(port('prompt'))).toBe(true);
    expect(isPortRequired(port('prompt'))).toBe(true);
  });

  it('Original is always required for both presets', () => {
    expect(isPortRequired(port('original'))).toBe(true);
    expect(isPortRequired(port('original'))).toBe(true);
  });

  it('Reference, Theme and Palette are optional', () => {
    for (const id of ['reference', 'theme', 'palette']) expect(isPortRequired(port(id))).toBe(false);
  });

  it('no other node has a required input', () => {
    for (const kind of ['palette', 'collection', 'output'] as const) {
      expect(getDefinition(kind).inputs.some((p) => isPortRequired(p))).toBe(false);
    }
  });
});
