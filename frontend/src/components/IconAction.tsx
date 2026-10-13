import type { ReactNode } from 'react';

const paths = {
  preview: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  add: <path d="M12 5v14M5 12h14" />,
  copy: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" /></>,
  duplicate: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  import: <path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />,
  expand: <path d="M9 3H3v6m0-6 7 7m5-7h6v6m0-6-7 7M3 15v6h6m-6 0 7-7m11 1v6h-6m6 0-7-7" />,
  delete: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1" /><path d="m3 17 6-6 4 4 3-3 5 5" /></>,
  download: <path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" />,
  variation: <><path d="M3 6h3c4 0 8 12 12 12h3m-4-4 4 4-4 4M3 18h3c1.6 0 3.2-2 4.8-4.5M13.2 10.5C14.8 8 16.4 6 18 6h3m-4-4 4 4-4 4" /></>,
} satisfies Record<string, ReactNode>;

export function ActionGlyph({ icon }: { icon: keyof typeof paths }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[icon]}</svg>;
}

export function IconAction({ icon, label, onClick, disabled, danger }: {
  icon: keyof typeof paths; label: string; onClick?: () => void; disabled?: boolean; danger?: boolean;
}) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
    className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'text-danger hover:bg-danger-soft' : 'text-ink-2 hover:bg-panel-2 hover:text-ink'}`}>
    <ActionGlyph icon={icon} />
  </button>;
}
