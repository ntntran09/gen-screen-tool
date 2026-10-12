import { NodeIcon } from './NodeIcon';
import { useEffect, useRef } from 'react';
import { ADDABLE_KINDS, getDefinition } from '../graph/registry';
import type { NodeKind } from '../graph/types';

export function AddNodeMenu({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (kind: NodeKind) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Add node"
      className="fixed z-50 w-56 rounded-xl border-2 border-outline bg-panel p-1"
      style={{ left: x, top: y }}
    >
      <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Add node</p>
      {ADDABLE_KINDS.map((kind) => {
        const def = getDefinition(kind);
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ink-2 outline-none hover:bg-panel-2 hover:text-ink focus:bg-panel-2 focus:text-ink"
            onClick={() => onPick(kind)}
          >
            <NodeIcon kind={kind} size={14} />
            {def.label}
          </button>
        );
      })}
    </div>
  );
}
