/** Ready-made sentences for the Prompt node, to fine-tune the output without retyping them. */
export interface PromptSnippet {
  id: string;
  label: string;
  text: string;
  /** Only useful when this port of the Generate node has something connected. */
  needs?: 'reference' | 'theme' | 'palette';
}

export const PROMPT_SNIPPETS: PromptSnippet[] = [
  {
    id: 'reference',
    label: 'Follow reference',
    needs: 'reference',
    text: 'Follow the attached visual references closely: reuse their shapes, details and composition cues.',
  },
  {
    id: 'palette',
    label: 'Follow palette',
    needs: 'palette',
    text: 'Follow the given color palette strictly for the overall colors, and do not introduce colors outside it.',
  },
  {
    id: 'theme',
    label: 'Follow theme image',
    needs: 'theme',
    text: 'Match the art style, shading and materials of the style references as closely as possible.',
  },
  {
    id: 'layout',
    label: 'Keep layout',
    text: 'Do not change the layout, positions or number of objects.',
  },
  {
    id: 'colors',
    label: 'Keep original colors',
    text: "Keep each object's original color; only change how it is drawn.",
  },
  {
    id: 'bold',
    label: 'Stronger change',
    text: 'Push the theme boldly: change shapes, materials and details strongly.',
  },
  {
    id: 'subtle',
    label: 'Subtle change',
    text: 'Make only subtle changes and stay close to the original.',
  },
];

/**
 * The ports of the Generate node(s) a Prompt node feeds that have something connected, e.g. `['palette', 'reference']`.
 * Empty when the Prompt feeds no Generate node yet.
 */
export function connectedPorts(
  promptId: string,
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string; targetHandle?: string | null }[],
): { feeds: boolean; ports: Set<string> } {
  const generates = new Set(
    edges.filter((e) => e.source === promptId && e.targetHandle === 'prompt')
      .map((e) => e.target)
      .filter((id) => nodes.find((n) => n.id === id)?.type === 'generate'),
  );
  const ports = new Set(edges.filter((e) => generates.has(e.target) && e.targetHandle).map((e) => e.targetHandle as string));
  return { feeds: generates.size > 0, ports };
}

/**
 * The sentences worth offering: the always-useful ones, plus "follow ..." only when that input is connected.
 * Before the Prompt is wired to a Generate node nothing is known, so every sentence is offered.
 */
export function availableSnippets(feeds: boolean, ports: Set<string>): PromptSnippet[] {
  return PROMPT_SNIPPETS.filter((s) => !feeds || !s.needs || ports.has(s.needs));
}

/** The prompt with the sentence added on its own line; unchanged if it is already there. */
export function appendSnippet(prompt: string, snippet: string): string {
  if (prompt.includes(snippet)) return prompt;
  const base = prompt.replace(/\s+$/, '');
  return base ? `${base}\n${snippet}` : snippet;
}

/** True when the prompt already contains the sentence (its chip shows as added). */
export const hasSnippet = (prompt: string, snippet: string) => prompt.includes(snippet);
