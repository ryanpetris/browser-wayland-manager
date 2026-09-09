// Innkeeper: the sessions a signed-in account may reach, and the dialogs that manage them.
import { useEffect, useRef, useState } from 'react';
import { Grid2X2, List, Monitor, Plus } from 'lucide-react';
import { IconButton } from './components/ui.jsx';
import { Dialog } from './components/Dialog.jsx';
import { Header } from './components/Header.jsx';
import { Login } from './components/Login.jsx';
import { SessionList } from './components/Sessions.jsx';
import { SessionForm } from './components/SessionForm.jsx';
import { Accounts } from './components/Accounts.jsx';
import { Sharing } from './components/Sharing.jsx';

export function App() {
  const [version, setVersion] = useState('');
  const [localElsewhere, setLocalElsewhere] = useState(false);
  const [token, setToken] = useState('');
  const [user, setUser] = useState(null);
  const [setupRequired, setSetupRequired] = useState(null);
  const [accountPanel, setAccountPanel] = useState(false);
  const [sharing, setSharing] = useState(null);
  const loginClock = useRef(null);
  function acceptLogin(data) {
    setUser(data.user);
    setToken(data.csrf_token);
    setAuthenticated(true);
    loginClock.current = { remaining: data.session_expires_at_ms - data.server_time_ms, at: performance.now() };
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch('/api/me');
        if (response.ok) {
          const data = await response.json();
          if (live) acceptLogin(data);
        } else if (response.status === 401) {
          const setup = await fetch('/api/setup');
          if (!setup.ok) throw new Error('Account setup is unavailable.');
          const data = await setup.json();
          if (live) setSetupRequired(data.required);
        } else throw new Error('Account service is unavailable.');
      } catch (e) {
        if (live) {
          setSetupRequired(false);
          setError(e.message);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [layout, setLayout] = useState(() => localStorage.getItem('innkeeper-layout') || 'grid');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState('');
  const [createError, setCreateError] = useState('');
  const logPane = useRef(null);
  const followLogs = useRef(true);
  const [logs, setLogs] = useState(null);
  const [logText, setLogText] = useState('Loading logs…');
  const [busy, setBusy] = useState({});
  const currentToken = useRef(token);
  currentToken.current = token;
  useEffect(() => {
    if (followLogs.current && logPane.current) logPane.current.scrollTop = logPane.current.scrollHeight;
  }, [logText]);
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      ...options,
      body: options.body ?? (options.method && options.method !== 'GET' ? '{}' : undefined),
      headers: {
        'X-Innkeeper-CSRF': token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (currentToken.current !== token) throw new Error('Session ended.');
    if (response.status === 401) {
      setAuthenticated(false);
      setUser(null);
      setToken('');
      setSetupRequired(false);
      throw new Error('Your session has ended. Sign in again.');
    }
    if (!response.ok) {
      let body = await response.json().catch(() => ({}));
      throw new Error(body.message || body.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response;
  }
  async function refresh(signal) {
    const response = await api('/sessions', { signal });
    const data = await response.json();
    if (currentToken.current !== token || signal?.aborted) return;
    setSessions(data.sessions);
    setVersion(data.version);
    setLocalElsewhere(Boolean(data.local_elsewhere));
    setAuthenticated(true);
  }
  useEffect(() => {
    if (!token) return;
    let live = true,
      inflight = false;
    const controller = new AbortController();
    const tick = async () => {
      if (document.hidden || inflight) return;
      inflight = true;
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (live) setError(e.message);
      } finally {
        inflight = false;
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [token]);
  useEffect(() => {
    localStorage.setItem('innkeeper-layout', layout);
  }, [layout]);
  useEffect(() => {
    if (!logs) return;
    let live = true,
      inflight = false;
    const controller = new AbortController();
    async function tick() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await api(`/sessions/${logs.id}/logs`, { signal: controller.signal });
        const data = await r.json();
        if (live) setLogText(data.text.replace(/\x1b\[[0-9;]*m/g, '') || 'Waiting for output…');
      } catch (e) {
        if (live) setLogText(e.message);
      } finally {
        inflight = false;
      }
    }
    tick();
    const timer = setInterval(() => {
      if (!document.hidden) tick();
    }, 2000);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [logs?.id, token]);
  async function action(session, kind) {
    if (kind === 'destroy' && !confirm(`Destroy “${session.name}” and permanently delete its session data?`)) return;
    setBusy(b => ({ ...b, [session.id]: true }));
    setError('');
    try {
      await api(`/sessions/${session.id}${kind === 'destroy' ? '' : `/${kind}`}`, { method: kind === 'destroy' ? 'DELETE' : 'POST' });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(b => {
        const next = { ...b };
        delete next[session.id];
        return next;
      });
    }
  }
  function openSession(session) {
    window.open(`/api/sessions/${session.id}/connect`, '_blank', 'noopener,noreferrer');
  }
  useEffect(() => {
    if (!token) return;
    let live = true,
      inflight = false;
    async function renew() {
      if (inflight || !live) return;
      inflight = true;
      try {
        const response = await api('/me');
        const data = await response.json();
        if (!live) return;
        setUser(data.user);
        if (data.csrf_token !== token) {
          setToken(data.csrf_token);
          return;
        }
        loginClock.current = { remaining: data.session_expires_at_ms - data.server_time_ms, at: performance.now() };
        if (loginClock.current.remaining > 0 && loginClock.current.remaining <= 2 * 86400000) {
          const renewal = await api('/session/renew', { method: 'POST' });
          const renewed = await renewal.json();
          if (live) loginClock.current = { remaining: renewed.session_expires_at_ms - renewed.server_time_ms, at: performance.now() };
        }
      } catch (e) {
        if (live) setError(e.message);
      } finally {
        inflight = false;
      }
    }
    renew();
    const timer = setInterval(renew, 60000);
    window.addEventListener('focus', renew);
    window.addEventListener('online', renew);
    document.addEventListener('visibilitychange', renew);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', renew);
      window.removeEventListener('online', renew);
      document.removeEventListener('visibilitychange', renew);
    };
  }, [token]);
  if (!authenticated)
    return (
      <Login
        required={setupRequired}
        error={error}
        submit={async input => {
          setError('');
          try {
            const response = await fetch(`/api/${setupRequired ? 'setup' : 'login'}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            });
            const data = await response.json();
            if (!response.ok) {
              if (data.error === 'setup_complete') setSetupRequired(false);
              throw new Error(data.message || 'Sign in failed.');
            }
            acceptLogin(data);
            const destination = new URLSearchParams(location.search).get('return');
            if (destination && /^\/api\/sessions\/[0-9a-f-]{36}\/connect$/.test(destination)) location.replace(destination);
          } catch (e) {
            setError(e.message);
          }
        }}
      />
    );
  const running = sessions.filter(s => s.status === 'running').length;
  const editingSession = editing && (sessions.find(s => s.id === editing.id) || editing);
  const timings = Object.entries((logs && (sessions.find(s => s.id === logs.id) || logs).timings) || {})
    .map(([stage, ms]) => `${stage}: ${(ms / 1000).toFixed(2)}s`)
    .join(' · ');
  return (
    <div className="flex min-h-dvh flex-col bg-canvas font-sans text-ink-2">
      <Header
        user={user}
        onAccount={() => setAccountPanel(true)}
        onSignOut={async () => {
          try {
            await api('/logout', { method: 'POST' });
          } catch (e) {
            setError(e.message);
            return;
          }
          currentToken.current = '';
          setToken('');
          setUser(null);
          setSetupRequired(false);
          setAuthenticated(false);
          setLogs(null);
          setCreating(false);
          setEditing(null);
          setSessions([]);
        }}
      />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">Your workspace</p>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">Sessions</h1>
            <p className="mt-1 text-sm text-ink-3">Create a desktop. Open it anywhere.</p>
          </div>
          <button type="button" className="btn btn-primary h-9" onClick={() => setCreating(true)}>
            <Plus className="size-4" strokeWidth={2} />
            New session
          </button>
        </div>
        {error && (
          <div role="alert" className="callout callout-bad mt-6 flex items-center gap-3">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span>
            <button type="button" className="btn btn-outline btn-xs" onClick={() => setError('')}>
              Dismiss
            </button>
          </div>
        )}
        <div className="mt-6 flex items-center justify-between gap-3 border-b border-line pb-3">
          <p className="text-xs text-ink-3">
            <span className="font-medium text-ink">{running} running</span> / {sessions.length} total
          </p>
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5">
            <IconButton icon={Grid2X2} label="Grid view" active={layout === 'grid'} onClick={() => setLayout('grid')} />
            <IconButton icon={List} label="List view" active={layout === 'list'} onClick={() => setLayout('list')} />
          </div>
        </div>
        {!sessions.length ? (
          <div className="mt-5 flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-2 px-6 py-20 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-4">
              <Monitor className="size-6" strokeWidth={1.5} />
            </span>
            <h2 className="text-sm font-semibold text-ink">Your first desktop starts here</h2>
            <p className="max-w-sm text-xs leading-relaxed text-ink-4">
              Pick a distribution, add the packages you want, and Innkeeper builds the machine.
            </p>
            <button type="button" className="btn btn-primary btn-sm mt-1" onClick={() => setCreating(true)}>
              Create a session
            </button>
          </div>
        ) : (
          <SessionList
            sessions={sessions}
            layout={layout}
            user={user}
            busy={busy}
            api={api}
            onOpen={openSession}
            onLogs={s => {
              followLogs.current = true;
              setLogText('Loading logs…');
              setLogs(s);
            }}
            onEdit={s => {
              setEditError('');
              setEditing(s);
            }}
            onShare={setSharing}
            onAction={action}
          />
        )}
      </main>
      <footer className="border-t border-line px-4 py-4 sm:px-6">
        <p className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 text-[11px] text-ink-4">
          Elsewhere Innkeeper <code className="font-mono text-ink-3">v{version}</code>
          {localElsewhere && <span>· Local Elsewhere build</span>}
        </p>
      </footer>
      {accountPanel && <Accounts api={api} user={user} changed={setUser} close={() => setAccountPanel(false)} />}
      {sharing && <Sharing api={api} machine={sharing} close={() => setSharing(null)} />}
      {creating && (
        <Dialog title="New session" close={() => setCreating(false)}>
          <SessionForm
            administrator={user?.role === 'administrator'}
            error={createError}
            submit={async profile => {
              setCreateError('');
              try {
                await api('/sessions', { method: 'POST', body: JSON.stringify(profile) });
                setCreating(false);
                await refresh();
              } catch (e) {
                setCreateError(e.message);
              }
            }}
          />
        </Dialog>
      )}
      {editing && (
        <Dialog
          title="Edit settings"
          description="Save applies the name immediately. Other settings apply on the next launch. Relaunch closes running applications."
          close={() => setEditing(null)}
        >
          {editingSession.settings_pending && (
            <p role="status" className="callout callout-info mx-4 mt-4">
              Settings pending · Applies on next launch
            </p>
          )}
          <SessionForm
            key={editing.id}
            initial={editing}
            error={editError}
            submit={async profile => {
              setEditError('');
              try {
                await api(`/sessions/${editing.id}/settings`, {
                  method: 'PUT',
                  body: JSON.stringify({
                    name: profile.name,
                    screen_size: profile.screen_size,
                    kiosk: profile.kiosk,
                    startup_command: profile.startup_command,
                  }),
                });
                setEditing(null);
                await refresh();
              } catch (e) {
                setEditError(e.message);
              }
            }}
          />
        </Dialog>
      )}
      {logs && (
        <Dialog title={`Logs · ${logs.name}`} description={timings || undefined} close={() => setLogs(null)} size="xl">
          <pre
            ref={logPane}
            onScroll={e => {
              const node = e.currentTarget;
              followLogs.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
            tabIndex={0}
            className="h-[60vh] overflow-auto bg-canvas p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2 select-text [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            {logText}
          </pre>
        </Dialog>
      )}
    </div>
  );
}
