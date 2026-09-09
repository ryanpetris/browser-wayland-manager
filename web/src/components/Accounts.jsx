// The account panel: your own profile and password, and — for an administrator — every other account.
import { useEffect, useState } from 'react';
import { Alert, Badge, Eyebrow, Field } from './ui.jsx';
import { Dialog } from './Dialog.jsx';

export function Accounts({ api, user, changed, close }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const administrator = user.role === 'administrator';
  async function reload() {
    if (administrator) setUsers((await (await api('/users')).json()).users);
  }
  useEffect(() => {
    reload().catch(e => setError(e.message));
  }, [user.role]);
  async function perform(work) {
    setBusy(true);
    setError('');
    try {
      await work();
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Account" close={close} size="lg">
      <div className="flex flex-col gap-5 p-4">
        {error && <Alert>{error}</Alert>}
        <section className="card p-4">
          <Eyebrow>Your account</Eyebrow>
          <p className="mt-1.5 text-xs text-ink-3">
            Signed in as <span className="font-mono text-ink-2">{user.username}</span>
          </p>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={e => {
              e.preventDefault();
              const display_name = e.currentTarget.display_name.value;
              perform(async () => {
                const result = await (await api('/me', { method: 'PATCH', body: JSON.stringify({ display_name }) })).json();
                changed(result.user);
              });
            }}
          >
            <Field label="Display name">
              <input className="input" name="display_name" defaultValue={user.display_name} required maxLength={120} />
            </Field>
            <button className="btn btn-outline btn-sm self-start" disabled={busy}>Save display name</button>
          </form>
        </section>

        <section className="card p-4">
          <Eyebrow>Password</Eyebrow>
          <p className="mt-1.5 text-xs text-ink-3">Changing it ends this session on every device.</p>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={e => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              perform(async () => {
                await api('/me/password', {
                  method: 'PUT',
                  body: JSON.stringify({ current_password: data.get('current_password'), password: data.get('password') }),
                });
                location.reload();
              });
            }}
          >
            <Field label="Current password">
              <input className="input" type="password" name="current_password" autoComplete="current-password" required />
            </Field>
            <Field label="New password" hint="At least 12 characters.">
              <input className="input" type="password" name="password" autoComplete="new-password" minLength={12} required />
            </Field>
            <button className="btn btn-outline btn-sm self-start" disabled={busy}>Change password and sign out</button>
          </form>
        </section>

        {administrator && (
          <>
            <section>
              <Eyebrow>Users</Eyebrow>
              {users === null ? (
                <p role="status" className="mt-2 text-xs text-ink-4">Loading accounts…</p>
              ) : (
                <div className="mt-2 flex flex-col gap-3">
                  {users.map(target => (
                    <UserForm key={target.id + target.username + target.display_name + target.role + target.enabled} target={target} busy={busy} perform={perform} api={api} user={user} changed={changed} />
                  ))}
                </div>
              )}
            </section>

            <section className="card p-4">
              <Eyebrow>Create user</Eyebrow>
              <form
                className="mt-4 flex flex-col gap-3"
                onSubmit={e => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const data = new FormData(form);
                  perform(async () => {
                    await api('/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(data)) });
                    form.reset();
                  });
                }}
              >
                <Field label="Username">
                  <input className="input" name="username" required maxLength={64} autoComplete="off" />
                </Field>
                <Field label="Display name">
                  <input className="input" name="display_name" required maxLength={120} />
                </Field>
                <Field label="Password" hint="At least 12 characters.">
                  <input className="input" name="password" type="password" minLength={12} autoComplete="new-password" required />
                </Field>
                <Field label="Account role">
                  <select className="select select-md w-full" name="role">
                    <option value="user">User</option>
                    <option value="administrator">Administrator</option>
                  </select>
                </Field>
                <button className="btn btn-primary btn-sm self-start" disabled={busy}>Create user</button>
              </form>
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}

function UserForm({ target, busy, perform, api, user, changed }) {
  return (
    <form
      className="card p-4"
      onSubmit={e => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        perform(async () => {
          const result = await (
            await api(`/users/${target.id}`, {
              method: 'PATCH',
              body: JSON.stringify({
                username: data.get('username'),
                display_name: data.get('display_name'),
                role: data.get('role'),
                enabled: data.get('enabled') === 'on',
              }),
            })
          ).json();
          if (target.id === user.id) changed(result.user);
        });
      }}
    >
      <div className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{target.display_name}</h4>
        {target.role === 'administrator' && <Badge tone="accent">Administrator</Badge>}
        {!target.enabled && <Badge tone="warn">Disabled</Badge>}
      </div>
      <div className="mt-4 flex flex-col gap-3">
        <Field label="Username">
          <input className="input" name="username" defaultValue={target.username} required maxLength={64} />
        </Field>
        <Field label="Display name">
          <input className="input" name="display_name" defaultValue={target.display_name} required maxLength={120} />
        </Field>
        <Field label="Account role">
          <select className="select select-md w-full" name="role" defaultValue={target.role}>
            <option value="user">User</option>
            <option value="administrator">Administrator</option>
          </select>
        </Field>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
          <input type="checkbox" className="check" name="enabled" defaultChecked={target.enabled} />
          Enabled
        </label>
        <div className="flex flex-wrap gap-1.5">
          <button className="btn btn-outline btn-sm" disabled={busy}>Save account</button>
          <button
            className="btn btn-outline btn-sm text-bad hover:bg-bad/10 hover:text-bad"
            disabled={busy}
            type="button"
            onClick={() =>
              perform(async () => {
                if (confirm(`Delete account ${target.display_name}?`)) await api(`/users/${target.id}`, { method: 'DELETE' });
              })
            }
          >
            Delete account
          </button>
        </div>
        <div className="border-t border-line pt-3">
          <Field label="Reset password" hint="At least 12 characters. The account is signed out everywhere.">
            <input className="input" name="reset_password" type="password" autoComplete="new-password" minLength={12} />
          </Field>
          <button
            type="button"
            className="btn btn-outline btn-sm mt-3"
            disabled={busy}
            onClick={e => {
              const field = e.currentTarget.form.reset_password;
              if (!field.value || !field.reportValidity()) return;
              perform(async () => {
                await api(`/users/${target.id}/password`, { method: 'PUT', body: JSON.stringify({ password: field.value }) });
                field.value = '';
              });
            }}
          >
            Reset password
          </button>
        </div>
      </div>
    </form>
  );
}
