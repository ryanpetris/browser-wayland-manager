// A modal dialog: the native element, so Escape, the backdrop and the focus trap come from the browser.
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { IconButton, cx } from './ui.jsx';

const WIDTHS = { md: 'w-[32rem]', lg: 'w-[38rem]', xl: 'w-[68rem]' };

export function Dialog({ title, description, close, size = 'md', children }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={close}
      // `open:` keeps the layout off the closed element, which the browser hides for us.
      className={cx(
        'm-auto max-h-[86dvh] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border border-line-2 bg-surface p-0 font-sans text-ink-2 shadow-pop open:flex open:animate-pop',
        WIDTHS[size],
      )}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        </div>
        <IconButton icon={X} label="Close dialog" onClick={close} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </dialog>
  );
}
