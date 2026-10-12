import type { ReactNode } from 'react';
import { getDefinition } from '../graph/registry';
import type { NodeKind } from '../graph/types';

/** Line icons per node type (paths adapted from Lucide, ISC licence). */
const PATHS: Record<NodeKind, ReactNode> = {
  prompt: <path d="M4 7V4h16v3M9 20h6M12 4v16" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  palette: (
    <>
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z" />
      <circle cx="13.5" cy="6.5" r="1" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r="1" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r="1" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r="1" fill="currentColor" />
    </>
  ),
  collection: (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
    </>
  ),
  extract: (
    <>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
    </>
  ),
  generate: (
    <>
      <path d="M9.94 14.5 8.5 20l-1.44-5.5L1.5 13l5.56-1.44L8.5 6l1.44 5.56L15.5 13Z" />
      <path d="M19 2v6M16 5h6" />
    </>
  ),
  output: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
};

/** The node type's icon in its colour (slightly darkened so light colours stay legible). */
export function NodeIcon({ kind, size = 16 }: { kind: NodeKind; size?: number }) {
  const color = getDefinition(kind).color;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      style={{ color: `color-mix(in srgb, ${color} 82%, black)` }}
      aria-hidden
    >
      {PATHS[kind]}
    </svg>
  );
}
