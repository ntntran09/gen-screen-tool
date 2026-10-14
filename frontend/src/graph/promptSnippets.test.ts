import { expect, it } from 'vitest';
import { appendSnippet, availableSnippets, connectedPorts, hasSnippet, PROMPT_SNIPPETS } from './promptSnippets';

const reference = PROMPT_SNIPPETS.find((s) => s.id === 'reference')!;
const palette = PROMPT_SNIPPETS.find((s) => s.id === 'palette')!;

it('adds a sentence on its own line, or starts the prompt with it', () => {
  expect(appendSnippet('', reference.text)).toBe(reference.text);
  expect(appendSnippet('Make it crochet.  \n', reference.text)).toBe(`Make it crochet.\n${reference.text}`);
  expect(appendSnippet(appendSnippet('Make it crochet.', reference.text), palette.text)).toBe(`Make it crochet.\n${reference.text}\n${palette.text}`);
});

it('never adds the same sentence twice', () => {
  const once = appendSnippet('Make it crochet.', reference.text);
  expect(appendSnippet(once, reference.text)).toBe(once);
  expect(hasSnippet(once, reference.text)).toBe(true);
  expect(hasSnippet(once, palette.text)).toBe(false);
});

it('every sentence is unique and does not use a placeholder brace', () => {
  expect(new Set(PROMPT_SNIPPETS.map((s) => s.text)).size).toBe(PROMPT_SNIPPETS.length);
  expect(PROMPT_SNIPPETS.some((s) => /[{}]/.test(s.text))).toBe(false); // braces would read as placeholders
});

const nodes = [
  { id: 'p', type: 'prompt' }, { id: 'g', type: 'generate' }, { id: 'other', type: 'generate' },
  { id: 'ref', type: 'image' }, { id: 'pal', type: 'palette' }, { id: 'th', type: 'image' },
];
const wire = (source: string, target: string, targetHandle: string) => ({ source, target, targetHandle });
const labels = (feeds: boolean, ports: Set<string>) => availableSnippets(feeds, ports).map((s) => s.id);

it('offers every sentence until the prompt is wired to a Generate node', () => {
  const { feeds, ports } = connectedPorts('p', nodes, []);
  expect(feeds).toBe(false);
  expect(labels(feeds, ports)).toHaveLength(PROMPT_SNIPPETS.length);
});

it('offers follow reference / palette / theme only when that input is connected', () => {
  const edges = [wire('p', 'g', 'prompt')];
  let { feeds, ports } = connectedPorts('p', nodes, edges);
  expect(feeds).toBe(true);
  expect(labels(feeds, ports)).toEqual(['layout', 'colors', 'bold', 'subtle']); // nothing connected yet
  ({ feeds, ports } = connectedPorts('p', nodes, [...edges, wire('ref', 'g', 'reference'), wire('pal', 'g', 'palette')]));
  expect(labels(feeds, ports)).toEqual(['reference', 'palette', 'layout', 'colors', 'bold', 'subtle']);
  ({ feeds, ports } = connectedPorts('p', nodes, [...edges, wire('th', 'g', 'theme')]));
  expect(labels(feeds, ports)).toContain('theme');
});

it('ignores inputs connected to a different Generate node', () => {
  const edges = [wire('p', 'g', 'prompt'), wire('ref', 'other', 'reference')];
  const { feeds, ports } = connectedPorts('p', nodes, edges);
  expect(labels(feeds, ports)).not.toContain('reference');
});

