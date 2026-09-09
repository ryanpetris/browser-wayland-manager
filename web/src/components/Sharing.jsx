// Who else may reach this machine, and how far their access goes.
import { useEffect, useState } from 'react';
import { Alert, Badge, Loading, Section } from './ui.jsx';

export function Sharing({ api, machine }) {
  const [users, setUsers] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function reload() {
    const [u, a] = await Promise.all([api('/users').then(r => r.json()), api(`/sessions/${machine.id}/access`).then(r => r.json())]);
    setUsers(u.users);
    setAssignments(a.assignments);
  }
  // Assignments another administrator changes appear on return to the tab.
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) reload().catch(e => setError(e.message));
    };
    refresh();
    addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [machine.id]);
  return (
    <Section title="People with access" description="Administrators can always manage this machine.">
      <div className="flex flex-col gap-2 p-4">
        {error && <Alert>{error}</Alert>}
        {users === null && !error && <Loading>Loading accounts…</Loading>}
        {(users ?? []).map(user => (
          <label
            key={user.id}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-line-2 sm:flex-row sm:items-center"
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <span className="text-sm text-ink [overflow-wrap:anywhere]">{user.display_name}</span>
              {user.role === 'administrator' && <Badge tone="accent">Administrator</Badge>}
            </span>
            <select
              className="select select-md w-full min-w-0 shrink-0 sm:w-64"
              aria-label={`Access for ${user.display_name}`}
              disabled={busy}
              value={assignments.find(a => a.user_id === user.id)?.role || ''}
              onChange={async e => {
                setBusy(true);
                setError('');
                const role = e.target.value;
                try {
                  await api(`/sessions/${machine.id}/access/${user.id}`, {
                    method: role ? 'PUT' : 'DELETE',
                    body: role ? JSON.stringify({ role }) : undefined,
                  });
                  await reload();
                } catch (e) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <option value="">No assignment</option>
              <option value="viewer">Viewer · video and audio</option>
              <option value="interactive">Interactive · use desktop</option>
              <option value="manager">Manager · use and manage machine</option>
            </select>
          </label>
        ))}
      </div>
    </Section>
  );
}
