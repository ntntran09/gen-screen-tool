import { useId, type ReactNode } from 'react';

const inputCls =
  'w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-focus';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[11px] font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-[11px] text-ink-3">{hint}</p>}
    </div>
  );
}

export function TextInput(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  onBlur?: () => void;
  onEnter?: () => void;
}) {
  return (
    <Field label={props.label} hint={props.hint}>
      {(id) => (
        <input
          id={id}
          className={inputCls}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && props.onEnter) {
              e.preventDefault();
              props.onEnter();
            }
          }}
        />
      )}
    </Field>
  );
}

export function TextArea(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; hint?: ReactNode }) {
  return (
    <Field label={props.label} hint={props.hint}>
      {(id) => (
        <textarea
          id={id}
          className={`${inputCls} field-sizing-content min-h-16 resize-y leading-relaxed`}
          rows={props.rows ?? 4}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function NumberInput(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; hint?: ReactNode }) {
  return (
    <Field label={props.label} hint={props.hint}>
      {(id) => (
        <input
          id={id}
          type="number"
          className={inputCls}
          value={props.value}
          min={props.min}
          max={props.max}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (Number.isFinite(n)) props.onChange(Math.min(props.max, Math.max(props.min, n)));
          }}
        />
      )}
    </Field>
  );
}

export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly (T | { value: T; label: string })[];
  onChange: (v: T) => void;
  hint?: ReactNode;
}) {
  return (
    <Field label={props.label} hint={props.hint}>
      {(id) => (
        <select id={id} className={inputCls} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
          {props.options.map((o) => {
            const opt = typeof o === 'string' ? { value: o, label: o } : o;
            return (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            );
          })}
        </select>
      )}
    </Field>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12px] text-ink-2" title={props.hint}>
      <input
        type="checkbox"
        className="mt-0.5 accent-[var(--color-accent)]"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="space-y-3 border-b border-line px-4 py-4">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
        {note && <p className="mt-1 text-[11px] text-ink-3">{note}</p>}
      </div>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'ghost' | 'danger' | 'primary';
  disabled?: boolean;
  title?: string;
}) {
  const styles = {
    ghost: 'border-line text-ink-2 hover:bg-panel-2 hover:text-ink',
    danger: 'border-danger/50 text-danger hover:bg-danger-soft',
    primary: 'border-outline border-2 bg-accent font-semibold text-accent-ink hover:bg-accent-hover',
  }[variant];
  return (
    <button
      type="button"
      className={`rounded-md border px-2.5 py-1.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
