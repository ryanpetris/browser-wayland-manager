// Who else may reach this machine, and how far their access goes.
import { useEffect, useState } from 'react';
import { Alert, Badge } from './ui.jsx';
import { Dialog } from './Dialog.jsx';

export function Sharing({ api, machine, close }) {
  const [users, setUsers] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function reload() {
    const [u, a] = await Promise.all([api('/users').then(r => r.json()), api(`/sessions/${machine.id}/access`).then(r => r.json())]);
    setUsers(u.users);
    setAssignments(a.assignments);
  }
  useEffect(() => {
    reload().catch(e => setError(e.message));
  }, [machine.id]);
  return (
    <Dialog title={`Share ${machine.name}`} description="Administrators can always manage this machine." close={close} size="lg">
      <div className="flex flex-col gap-2 p-4">
        {error && <Alert>{error}</Alert>}
        {users === null && !error && <p role="status" className="text-xs text-ink-4">Loading accounts…</p>}
        {(users ?? []).map(user => (
          <label key={user.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 transition-colors hover:border-line-2">
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{user.display_name}</span>
            {user.role === 'administrator' && <Badge tone="accent">Administrator</Badge>}
            <select
              className="select select-md shrink-0"
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
    </Dialog>
  );
}
