import { useGraphStore } from '../store/graphStore';

export type ImageRole = 'Original' | 'Reference' | 'Theme';

const ROLE_BY_PORT: Record<string, ImageRole> = { original: 'Original', theme: 'Theme', reference: 'Reference' };

/** What an image node is used as, derived from the Generate ports it feeds. */
export function useImageRoles(nodeId: string): ImageRole[] {
  // A joined string keeps the selector result stable between renders.
  const joined = useGraphStore((s) =>
    [
      ...new Set(
        s.edges
          .filter((e) => e.source === nodeId && e.targetHandle && ROLE_BY_PORT[e.targetHandle])
          .map((e) => ROLE_BY_PORT[e.targetHandle!]),
      ),
    ]
      .sort()
      .join(','),
  );
  return joined ? (joined.split(',') as ImageRole[]) : [];
}
