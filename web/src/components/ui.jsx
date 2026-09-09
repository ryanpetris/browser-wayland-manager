// Small shared pieces: buttons, badges, fields, and the brand mark. The viewer draws its chrome from the same set.
import { cloneElement, useId } from 'react';


/// Class names, skipping the falsy ones.
export const cx = (...parts) => parts.filter(Boolean).join(' ');

/// An icon button. `active` marks a toggle that is on; leave it out on a button that is not a toggle.
export function IconButton({ icon: Icon, label, active, className = '', tone = 'neutral', ...props }) {
  return (
    <button
      {...props}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        'inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-accent/15 text-accent-2 ring-1 ring-accent/40 ring-inset' : 'text-ink-3 hover:bg-surface-3 hover:text-ink',
        tone === 'danger' && !active && 'hover:bg-bad/10 hover:text-bad',
        className,
      )}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

const TONES = {
  neutral: 'border-line-2 bg-surface-3 text-ink-2',
  accent: 'border-accent/30 bg-accent/10 text-accent-2',
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  bad: 'border-bad/30 bg-bad/10 text-bad',
};

/// A small status pill.
export function Badge({ tone = 'neutral', dot = false, pulse = false, className = '', children, ...props }) {
  return (
    <span {...props} className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[10px] font-medium whitespace-nowrap', TONES[tone], className)}>
      {dot && <span className={cx('size-1.5 rounded-full bg-current', pulse && 'animate-glow')} />}
      {children}
    </span>
  );
}

/// A vertical hairline between toolbar groups.
export const Divider = ({ className = '' }) => <span aria-hidden="true" className={cx('mx-1 h-5 w-px shrink-0 bg-line-2', className)} />;

/// A section title.
export const Eyebrow = ({ className = '', children }) => <h3 className={cx('eyebrow', className)}>{children}</h3>;

/// The brand mark: the monitor glyph on an accent tile.
export function Logo({ className = 'size-7' }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-accent to-[#a78bfa] text-white shadow-card', className)} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="size-[62%]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 20h8M12 17v3M7 9.5l2.5 2.5L7 14.5M12 14.5h4" />
      </svg>
    </span>
  );
}

/// A labelled control. The hint sits outside the label, so the control's name stays the label alone.
export function Field({ label, hint, className = '', children }) {
  const id = useId();
  return (
    <div className={className}>
      <label className="block">
        <span className="eyebrow mb-1.5 block">{label}</span>
        {hint ? cloneElement(children, { 'aria-describedby': id }) : children}
      </label>
      {hint && <p id={id} className="mt-1.5 text-[11px] leading-relaxed text-ink-4">{hint}</p>}
    </div>
  );
}

/// A form-wide message.
export const Alert = ({ children }) => <p role="alert" className="callout callout-bad">{children}</p>;
