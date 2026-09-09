// The session list: a live preview, the machine's state, and the actions the viewer's role allows.
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, Monitor, Play, Share2, SlidersHorizontal, Square, Terminal, Trash2, Wrench } from 'lucide-react';
import { Badge, IconButton, cx } from './ui.jsx';

// status → [badge tone, dot, pulse]
const STATUS = {
  running: ['ok', true, false],
  preparing: ['warn', true, true],
  upgrading: ['warn', true, true],
  failed: ['bad', true, false],
  stopped: ['neutral', false, false],
  cancelled: ['neutral', false, false],
};
const DISTRIBUTION = { arch: 'Arch Linux', debian: 'Debian 13' };

let activePreviews = 0;
const previewQueue = [];
function enqueuePreview(task) {
  previewQueue.push(task);
  function drain() {
    while (activePreviews < 2 && previewQueue.length) {
      activePreviews++;
      Promise.resolve(previewQueue.shift()()).finally(() => {
        activePreviews--;
        drain();
      });
    }
  }
  drain();
}

export function SessionList({ sessions, layout, user, busy, api, onOpen, onLogs, onEdit, onShare, onAction }) {
  return (
    <div
      className={cx(
        'mt-5',
        layout === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-4' : 'flex flex-col gap-3',
      )}
    >
      {sessions.map(s => (
        <SessionCard
          key={s.id}
          s={s}
          layout={layout}
          user={user}
          busy={busy}
          api={api}
          onOpen={onOpen}
          onLogs={onLogs}
          onEdit={onEdit}
          onShare={onShare}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

function SessionCard({ s, layout, user, busy, api, onOpen, onLogs, onEdit, onShare, onAction }) {
  const [tone, dot, pulse] = STATUS[s.status] ?? STATUS.stopped;
  const manages = s.access_role === 'manager';
  const settled = ['running', 'stopped'].includes(s.status);
  // `session` is the marker the browser checks select cards by; it carries no styling.
  return (
    <article className={cx('session card flex overflow-hidden [overflow-wrap:anywhere]', layout === 'list' ? 'flex-row' : 'flex-col')}>
      <Preview session={s} layout={layout} api={api} />
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold break-words text-ink">{s.name}</h2>
          <Badge tone={tone} dot={dot} pulse={pulse}>{s.status}</Badge>
        </div>
        <p className="mt-1.5 text-xs text-ink-3">
          {DISTRIBUTION[s.distribution] ?? s.distribution}
          {s.packages?.length > 0 && <span className="text-ink-4"> · {s.packages.join(', ')}</span>}
        </p>
        <p className={cx('mt-0.5 text-xs', s.version_status === 'newer' ? 'text-warn' : 'text-ink-4')}>
          Elsewhere {s.installed_version || 'version unavailable'}
          {s.version_status === 'older' && ` · ${s.expected_version} available`}
          {s.version_status === 'newer' && ` · Newer than expected (${s.expected_version})`}
          {s.installed_version && s.version_status === 'unknown' && ' · Version comparison unavailable'}
        </p>
        <div className="mt-2 flex flex-col gap-1.5 empty:mt-0">
          {s.version_error && <Note>{s.version_error}</Note>}
          {s.repair_available && <Note>Elsewhere installation is incomplete. Repair installs the expected package and leaves the session stopped.</Note>}
          {['preparing', 'upgrading'].includes(s.status) && (
            <p role="status" className="flex items-center gap-1.5 text-xs text-warn">
              <Loader2 className="size-3 shrink-0 animate-spin" />
              {s.status === 'upgrading' ? 'Upgrading' : 'Preparing'}: {s.stage}…
            </p>
          )}
          {s.settings_pending && (
            <Note role="status">
              Settings pending · {['stopped', 'upgrading'].includes(s.status)
                ? 'Applies on next start'
                : s.status === 'preparing'
                  ? 'Applying on launch'
                  : s.status === 'failed'
                    ? 'Stop, then start to apply'
                    : 'Relaunch to apply'}
            </Note>
          )}
          {s.version_status === 'older' && <Note>Upgrade closes running applications and leaves the session stopped.</Note>}
          {s.error && <p className="callout callout-bad">{s.error}</p>}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-4">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={s.status !== 'running' || busy[s.id]}
            onClick={() => onOpen(s)}
          >
            <ExternalLink className="size-3.5" strokeWidth={1.75} />
            Open
          </button>
          {manages && (
            <>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => onLogs(s)}>
                <Terminal className="size-3.5" strokeWidth={1.75} />
                Logs
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={busy[s.id] || s.status === 'cancelled'}
                onClick={() => onAction(s, s.status === 'stopped' ? 'start' : 'stop')}
              >
                {s.status === 'stopped' ? <Play className="size-3.5" strokeWidth={1.75} /> : <Square className="size-3" strokeWidth={2} />}
                {s.status === 'stopped' ? 'Start' : 'Stop'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={busy[s.id] || !settled}
                onClick={() => onEdit(s)}
              >
                <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
                Edit settings
              </button>
              {(s.version_status === 'older' || s.repair_available) && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={busy[s.id] || !settled}
                  title="Install the expected Elsewhere version and leave the session stopped."
                  onClick={() => onAction(s, 'upgrade')}
                >
                  <Wrench className="size-3.5" strokeWidth={1.75} />
                  {s.repair_available ? 'Repair' : 'Upgrade'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={busy[s.id] || s.status !== 'running'}
                title="Restart with saved settings. Running applications will close."
                onClick={() => onAction(s, 'relaunch')}
              >
                Relaunch
              </button>
            </>
          )}
          {user?.role === 'administrator' && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => onShare(s)}>
              <Share2 className="size-3.5" strokeWidth={1.75} />
              Share
            </button>
          )}
          {manages && (
            <IconButton
              icon={Trash2}
              tone="danger"
              className="ml-auto"
              label={`Destroy ${s.name}`}
              disabled={busy[s.id]}
              onClick={() => onAction(s, 'destroy')}
            />
          )}
        </div>
      </div>
    </article>
  );
}

const Note = ({ children, ...props }) => <p {...props} className="text-xs leading-relaxed text-ink-3">{children}</p>;

function Preview({ session, layout, api }) {
  const ref = useRef(null);
  const [url, setUrl] = useState('');
  const urlRef = useRef('');
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  useEffect(() => {
    if (session.status !== 'running') {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = '';
      setUrl('');
    }
    let visible = false,
      disposed = false,
      inflight = false;
    const controller = new AbortController();
    async function capture() {
      if (disposed || inflight || !visible || document.hidden || session.status !== 'running') return;
      inflight = true;
      enqueuePreview(async () => {
        if (disposed || !visible || document.hidden) {
          inflight = false;
          return;
        }
        try {
          const width = Math.min(1600, Math.max(1, Math.ceil(ref.current.clientWidth * devicePixelRatio)));
          const r = await api(`/sessions/${session.id}/preview?width=${width}`, { signal: controller.signal });
          const blob = await r.blob();
          if (!disposed) {
            if (urlRef.current) URL.revokeObjectURL(urlRef.current);
            urlRef.current = URL.createObjectURL(blob);
            setUrl(urlRef.current);
          }
        } catch {
          // Keep the last frame through rate limits and temporary capture failures.
        } finally {
          inflight = false;
        }
      });
    }
    const observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) capture();
    });
    observer.observe(ref.current);
    const timer = setInterval(capture, 5000);
    document.addEventListener('visibilitychange', capture);
    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', capture);
    };
  }, [session.id, session.status, layout]);
  const list = layout === 'list';
  return (
    <div
      ref={ref}
      className={cx(
        'flex shrink-0 items-center justify-center overflow-hidden bg-canvas',
        list ? 'w-28 self-stretch border-r border-line sm:w-52' : 'aspect-video border-b border-line',
      )}
    >
      {url && session.status === 'running' ? (
        <img src={url} alt={`Desktop preview of ${session.name}`} className="size-full object-contain" />
      ) : (
        <div className="flex flex-col items-center gap-2 px-2 text-center text-ink-4">
          <Monitor className={list ? 'size-5' : 'size-7'} strokeWidth={1.5} />
          <span className="text-[11px] leading-tight">
            {session.status === 'running' ? 'Preview unavailable' : session.status === 'preparing' ? 'Preparing desktop…' : 'Desktop offline'}
          </span>
        </div>
      )}
    </div>
  );
}
