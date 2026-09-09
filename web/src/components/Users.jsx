// Account administration: the directory, the accounts in it, and the form that adds one.
import { useEffect, useState } from 'react';
import { ChevronRight, Plus, Trash2, UserRound, UserRoundPlus } from 'lucide-react';
import { Alert, Badge, EmptyState, Field, FormActions, Loading, PageHeader, Section } from './ui.jsx';
import { Confirm } from './Dialog.jsx';
import { Link, leave, navigate } from '../router.jsx';

/// Every account on the instance. Administrators are the only readers.
function useUsers(api) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const reload = () =>
    api('/users')
      .then(r => r.json())
      .then(data => setUsers(data.users))
      .catch(e => setError(e.message));
  useEffect(() => {
    reload();
  }, []);
  return { users, error, setError, reload };
}

export function UsersPage({ api, user }) {
  const { users, error } = useUsers(api);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-7">
      <PageHeader
        eyebrow="Administration"
        title="Users"
        description="Accounts that can sign in to this Innkeeper."
        action={
          <Link to="/users/new" className="btn btn-primary btn-lg">
            <Plus className="size-4" strokeWidth={2} />
            New user
          </Link>
        }
      />
      {error && <Alert>{error}</Alert>}
      {users === null && !error && <Loading>Loading accounts…</Loading>}
      {users?.length === 0 && <EmptyState icon={UserRound} title="No accounts yet" description="Create an account for each person who needs a desktop." />}
      {users?.length > 0 && (
        <div className="card overflow-hidden">
          {users.map(target => (
            <article
              key={target.id}
              className="group relative flex items-center gap-3 border-b border-line px-3.5 py-3 transition-colors last:border-0 hover:bg-surface-3"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-3 text-ink-3">
                <UserRound className="size-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-ink">
                  <Link to={`/users/${target.id}`} className="row-link transition-colors group-hover:text-accent-2">
                    {target.display_name}
                  </Link>
                </h2>
                <p className="truncate font-mono text-xs text-ink-4">{target.username}</p>
              </div>
              {target.id === user.id && <Badge>You</Badge>}
              {target.role === 'administrator' && <Badge tone="accent">Administrator</Badge>}
              {!target.enabled && <Badge tone="warn">Disabled</Badge>}
              <ChevronRight className="size-4 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5" strokeWidth={2} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewUserPage({ api }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <PageHeader
        back={{ to: '/users', label: 'Users' }}
        eyebrow="Administration"
        title="New user"
        description="The account can sign in as soon as it is created. Share the password over a channel you trust."
      />
      <form
        onSubmit={e => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError('');
          api('/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(data)) })
            .then(() => leave('/users/new', '/users'))
            .catch(e => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy} className="flex flex-col gap-5">
          <Section title="Identity" description="The username signs in; the display name is what everyone else sees.">
            <div className="flex flex-col gap-4 p-4">
              <Field label="Username">
                <input className="input" name="username" required maxLength={64} autoComplete="off" autoFocus />
              </Field>
              <Field label="Display name">
                <input className="input" name="display_name" required maxLength={120} />
              </Field>
            </div>
          </Section>
          <Section title="Access" description="Administrators manage every account and every machine.">
            <div className="flex flex-col gap-4 p-4">
              <Field label="Account role">
                <select className="select select-md w-full" name="role">
                  <option value="user">User</option>
                  <option value="administrator">Administrator</option>
                </select>
              </Field>
              <Field label="Password" hint="At least 12 characters.">
                <input className="input" name="password" type="password" minLength={12} autoComplete="new-password" required />
              </Field>
            </div>
          </Section>
          {error && <Alert>{error}</Alert>}
          <FormActions>
            <Link to="/users" className="btn btn-outline btn-sm">
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary btn-sm">
              <UserRoundPlus className="size-3.5" strokeWidth={1.75} />
              Create user
            </button>
          </FormActions>
        </fieldset>
      </form>
    </div>
  );
}

export function UserPage({ id, api, user, changed }) {
  const { users, error, setError, reload } = useUsers(api);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const target = users?.find(item => item.id === id);
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
  if (!target)
    return users === null && !error ? (
      <Loading>Loading account…</Loading>
    ) : (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
        {error && <Alert>{error}</Alert>}
        <EmptyState className="mt-6" icon={UserRound} title="This account is not available" description="It may have been deleted.">
          <Link to="/users" className="btn btn-outline btn-sm mt-1">
            Back to users
          </Link>
        </EmptyState>
      </div>
    );
  const self = target.id === user.id;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <PageHeader
        back={{ to: '/users', label: 'Users' }}
        eyebrow="Administration"
        title={target.display_name}
        badge={
          <>
            {target.role === 'administrator' && <Badge tone="accent">Administrator</Badge>}
            {!target.enabled && <Badge tone="warn">Disabled</Badge>}
          </>
        }
        description={self ? 'This is the account you are signed in as.' : undefined}
      />
      {error && <Alert>{error}</Alert>}

      <Section title="Identity and access" description="A disabled account keeps its machines but cannot sign in.">
        <form
          className="flex flex-col gap-4 p-4"
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
              if (self) changed(result.user);
            });
          }}
        >
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
          <button className="btn btn-primary btn-sm self-start" disabled={busy}>
            Save account
          </button>
        </form>
      </Section>

      <Section title="Password" description="A reset signs the account out everywhere. It does not need the current password.">
        <form
          className="flex flex-col gap-4 p-4"
          onSubmit={e => {
            e.preventDefault();
            const field = e.currentTarget.reset_password;
            perform(async () => {
              await api(`/users/${target.id}/password`, { method: 'PUT', body: JSON.stringify({ password: field.value }) });
              field.value = '';
            });
          }}
        >
          <Field label="New password" hint="At least 12 characters.">
            <input className="input" name="reset_password" type="password" autoComplete="new-password" minLength={12} required />
          </Field>
          <button className="btn btn-outline btn-sm self-start" disabled={busy}>
            Reset password
          </button>
        </form>
      </Section>

      <Section title="Danger zone" className="border-bad/25">
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <button type="button" className="btn btn-danger btn-sm self-start" disabled={busy} onClick={() => setConfirming(true)}>
            <Trash2 className="size-3.5" strokeWidth={1.75} />
            Delete account
          </button>
          <p className="text-[11px] leading-relaxed text-ink-4">
            The machines this account created stay, and Administrators keep managing them.
          </p>
        </div>
      </Section>

      {confirming && (
        <Confirm
          title={`Delete ${target.display_name}`}
          label="Delete account"
          tone="danger"
          close={() => setConfirming(false)}
          confirm={async () => {
            setBusy(true);
            setError('');
            try {
              await api(`/users/${target.id}`, { method: 'DELETE' });
              navigate('/users');
            } catch (e) {
              setError(e.message);
              setBusy(false);
            }
          }}
        >
          {self
            ? 'This deletes the account you are signed in as. You will be signed out immediately.'
            : 'This account will be signed out and will no longer be able to sign in. Its machine assignments are removed.'}
        </Confirm>
      )}
    </div>
  );
}
