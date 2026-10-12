import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/** Small right-click menu for one node or connection. Closes on outside click or Escape. */
export function ContextMenu({
  x,
  y,
  title,
  items,
  onClose,
}: {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
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
      aria-label={title}
      className="fixed z-50 min-w-44 rounded-xl border-2 border-outline bg-panel p-1"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p className="truncate px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</p>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.hint}
          className={`flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
            item.danger
              ? 'text-danger hover:bg-danger-soft focus:bg-danger-soft'
              : 'text-ink-2 hover:bg-panel-2 hover:text-ink focus:bg-panel-2 focus:text-ink'
          }`}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
