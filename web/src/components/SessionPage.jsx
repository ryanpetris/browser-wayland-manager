// One session in full: what it is, how it is doing, and every action grouped by what it changes.
import { useState } from 'react';
import { ExternalLink, Loader2, Play, RotateCw, SlidersHorizontal, Square, Trash2, Wrench } from 'lucide-react';
import { DataList, EmptyState, Loading, PageHeader, Section } from './ui.jsx';
import { Confirm } from './Dialog.jsx';
import { Link, navigate } from '../router.jsx';
import { Preview } from './Preview.jsx';
import { Logs } from './Logs.jsx';
import { Sharing } from './Sharing.jsx';
import { StatusBadge, busyState, distribution, elapsed, installLabel, pendingNote, screenLabel, settled } from './session.jsx';

const VERSION_NOTE = {
  current: 'This session runs the preferred Elsewhere version.',
  older: 'A newer Elsewhere version is preferred. Upgrading closes running applications.',
  newer: 'This session runs a newer build than the preferred version.',
  unknown: 'The installed version could not be compared with the preferred one.',
};

/// A group of buttons with the sentence that says what pressing one does.
const ActionRow = ({ hint, children }) => (
  <div className="flex flex-col gap-2 px-4 py-3.5">
    <div className="flex flex-wrap items-center gap-2">{children}</div>
    <p className="text-[11px] leading-relaxed text-ink-4">{hint}</p>
  </div>
);

export function SessionPage({ id, sessions, loaded, user, api, busy, now, onOpen, onAction }) {
  const [confirming, setConfirming] = useState('');
  const s = sessions.find(item => item.id === id);
  if (!s)
    return loaded ? (
      <EmptyState
        className="mt-10"
        title="This session is not available"
        description="It may have been destroyed, or your access to it may have been revoked."
      >
        <Link to="/" className="btn btn-outline btn-sm mt-1">
          Back to sessions
        </Link>
      </EmptyState>
    ) : (
      <Loading>Loading session…</Loading>
    );
  const manages = s.access_role === 'manager';
  const working = busy[s.id];
  const label = installLabel(s);
  return (
    <>
      <PageHeader
        back={{ to: '/', label: 'Sessions' }}
        eyebrow={distribution(s)}
        title={s.name}
        badge={<StatusBadge session={s} />}
        action={
          <button type="button" className="btn btn-primary btn-lg" disabled={s.status !== 'running' || working} onClick={() => onOpen(s)}>
            <ExternalLink className="size-4" strokeWidth={1.75} />
            Open desktop
          </button>
        }
      >
        <p className="mt-1.5 text-sm text-ink-3">Elsewhere {s.installed_version || 'version unavailable'}</p>
      </PageHeader>

      <div className="mt-6 flex flex-col gap-2 empty:mt-0">
        {busyState(s) && (
          <p role="status" className="callout flex items-center gap-2 border-warn/30 bg-warn/10 text-warn">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            {s.status === 'upgrading' ? 'Upgrading' : 'Preparing'}: {s.stage}…
          </p>
        )}
        {s.error && <p role="alert" className="callout callout-bad [overflow-wrap:anywhere]">{s.error}</p>}
        {s.settings_pending && (
          <p role="status" className="callout callout-info">
            Settings pending · {pendingNote(s)}
          </p>
        )}
        {s.repair_available && (
          <p className="callout callout-info">Elsewhere installation is incomplete. Install the preferred version before starting.</p>
        )}
        {s.version_error && <p className="callout callout-info">{s.version_error}</p>}
      </div>

      <div className="mt-6 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="card overflow-hidden">
            {/* A running desktop keeps the shape it is captured in; an idle one takes less of the page. */}
            <Preview
              session={s}
              api={api}
              interval={3000}
              className={s.status === 'running' ? 'aspect-video' : 'h-56 sm:h-64'}
              glyph="size-9"
            />
          </div>

          <Section
            title="Configuration"
            description={manages ? 'Distribution, packages and Docker options are fixed at creation.' : undefined}
            action={
              manages &&
              (settled(s) && !working ? (
                <Link to={`/sessions/${s.id}/settings`} className="btn btn-outline btn-sm">
                  <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
                  Edit settings
                </Link>
              ) : (
                // Settings are only saved for a settled session, so the way in closes with them.
                <button type="button" className="btn btn-outline btn-sm" disabled>
                  <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
                  Edit settings
                </button>
              ))
            }
          >
            <DataList
              items={[
                { label: 'Distribution', value: distribution(s) },
                manages && { label: 'Packages', value: s.packages?.length ? s.packages.join(', ') : <span className="text-ink-4">None</span> },
                manages && { label: 'Screen size', value: screenLabel(s) },
                manages && { label: 'Kiosk mode', value: s.kiosk ? 'On' : 'Off' },
                manages && {
                  label: 'Startup command',
                  value: s.startup_command ? <code className="font-mono">{s.startup_command}</code> : <span className="text-ink-4">None</span>,
                },
                manages &&
                  s.docker_args?.length > 0 && {
                    label: 'Docker options',
                    value: <code className="font-mono whitespace-pre-wrap">{s.docker_args.join('\n')}</code>,
                  },
              ]}
            />
          </Section>

        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Section title="Runtime" description={manages ? 'Whether the machine is up, and the controls that change that.' : undefined}>
            <DataList
              items={[
                { label: 'State', value: <StatusBadge session={s} /> },
                busyState(s) && { label: 'Stage', value: s.stage },
                s.status === 'running' && s.started_ms > 0 && { label: 'Launched', value: `${elapsed(s.started_ms, now)} ago` },
                manages && s.status === 'running' && s.port > 0 && { label: 'Port', value: <code className="font-mono">{s.port}</code> },
              ]}
            />
            {manages && (
              <div className="divide-y divide-line border-t border-line">
                  <ActionRow
                    hint={
                      s.status === 'stopped'
                        ? 'Starts the container and applies any pending settings.'
                        : 'Shuts the desktop down. Running applications will close.'
                    }
                  >
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      disabled={working || s.status === 'cancelled'}
                      onClick={() => onAction(s, s.status === 'stopped' ? 'start' : 'stop')}
                    >
                      {s.status === 'stopped' ? <Play className="size-3.5" strokeWidth={1.75} /> : <Square className="size-3" strokeWidth={2} />}
                      {s.status === 'stopped' ? 'Start' : 'Stop'}
                    </button>
                  </ActionRow>
                  <ActionRow hint="Restarts with the saved settings. Running applications will close.">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      disabled={working || s.status !== 'running'}
                      onClick={() => onAction(s, 'relaunch')}
                    >
                      <RotateCw className="size-3.5" strokeWidth={1.75} />
                      Relaunch
                    </button>
                  </ActionRow>
              </div>
            )}
          </Section>

          {manages && (
            <>
              <Section title="Elsewhere version">
                <DataList
                  items={[
                    { label: 'Installed', value: s.installed_version || <span className="text-ink-4">Unavailable</span> },
                    { label: 'Preferred', value: s.expected_version },
                  ]}
                />
                <div className="border-t border-line">
                  <ActionRow hint={VERSION_NOTE[s.version_status] ?? VERSION_NOTE.unknown}>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      disabled={working || !settled(s)}
                      onClick={() => setConfirming('install')}
                    >
                      <Wrench className="size-3.5" strokeWidth={1.75} />
                      {label}
                    </button>
                  </ActionRow>
                </div>
              </Section>

              <Section title="Danger zone" className="border-bad/25">
                <ActionRow hint="Removes the container and permanently deletes the session's home directory.">
                  <button type="button" className="btn btn-danger btn-sm" disabled={working} onClick={() => setConfirming('destroy')}>
                    <Trash2 className="size-3.5" strokeWidth={1.75} />
                    Destroy session
                  </button>
                </ActionRow>
              </Section>
            </>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-5 empty:mt-0">
        {manages && <Logs api={api} session={s} />}
        {user?.role === 'administrator' && <Sharing api={api} machine={s} />}
      </div>

      {confirming === 'install' && manages && (
        <Confirm
          title={`${label} ${s.name}`}
          label={label}
          disabled={working || !settled(s)}
          close={() => setConfirming('')}
          confirm={() => onAction(s, 'upgrade')}
        >
          This will close all running applications and stop the session. Unsaved changes may be lost.
        </Confirm>
      )}
      {confirming === 'destroy' && manages && (
        <Confirm
          title={`Destroy ${s.name}`}
          label="Destroy"
          tone="danger"
          disabled={working}
          close={() => setConfirming('')}
          confirm={() => {
            // The workspace is where a destroyed session belongs, and where a refusal is reported.
            navigate('/');
            onAction(s, 'destroy');
          }}
        >
          This permanently deletes the session and everything in its home directory. It cannot be undone.
        </Confirm>
      )}
    </>
  );
}
