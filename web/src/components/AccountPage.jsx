// Your own account: the name other people see, and the password that reaches it.
import { useState } from 'react';
import { Alert, Badge, DataList, Field, PageHeader, Section } from './ui.jsx';

export function AccountPage({ api, user, changed }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function perform(work) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <PageHeader
        eyebrow="Signed in"
        title="Your account"
        badge={user.role === 'administrator' && <Badge tone="accent">Administrator</Badge>}
        description="Only an Administrator can change your username or your account role."
      />
      {error && <Alert>{error}</Alert>}

      <Section title="Profile" description="Your display name appears wherever this account is listed.">
        <DataList items={[{ label: 'Username', value: <code className="font-mono">{user.username}</code> }]} />
        <form
          className="flex flex-col gap-4 border-t border-line p-4"
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
          <button className="btn btn-primary btn-sm self-start" disabled={busy}>
            Save display name
          </button>
        </form>
      </Section>

      <Section title="Password" description="Changing your password signs this account out on every device, including this one.">
        <form
          className="flex flex-col gap-4 p-4"
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
          <button className="btn btn-outline btn-sm self-start" disabled={busy}>
            Change password and sign out
          </button>
        </form>
      </Section>
    </div>
  );
}
