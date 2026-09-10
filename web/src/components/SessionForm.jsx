// The settings a session is created with, and the subset that can be changed afterwards.
import { useRef, useState } from 'react';
import { Alert, Disclosure, Field, FormActions, Section } from './ui.jsx';
import { Link } from '../router.jsx';

const defaultProfile = {
  name: '',
  distribution: 'arch',
  packages: [],
  docker_args: [],
  gpu_access: false,
  software_encoding: false,
  startup_command: '',
  screen_size: null,
  kiosk: false,
};
const screenPresets = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];

/// `note` says what saving does; `blocked`, when set, replaces it with why it cannot and holds the
/// commit back.
export function SessionForm({ submit, error, initial, gpuAvailable = false, administrator = false, cancelTo, note = '', blocked = '' }) {
  const defaults = { ...defaultProfile, gpu_access: gpuAvailable, software_encoding: !gpuAvailable };
  const [profile, setProfile] = useState(initial || defaults);
  const [packages, setPackages] = useState(initial?.packages.join(' ') || '');
  const [dockerArgs, setDockerArgs] = useState(initial?.docker_args?.join('\n') || '');
  const initialSize = initial?.screen_size;
  const initialPreset = initialSize ? `${initialSize.width}x${initialSize.height}` : 'dynamic';
  const [screen, setScreen] = useState(initialSize && !screenPresets.includes(initialPreset) ? 'custom' : initialPreset);
  const [width, setWidth] = useState(initialSize?.width ?? 1920);
  const [height, setHeight] = useState(initialSize?.height ?? 1080);
  const [text, setText] = useState('');
  const [importError, setImportError] = useState('');
  const importPanel = useRef(null);
  const [pending, setPending] = useState(false);
  function change(key, value) {
    setProfile(p => ({ ...p, [key]: value }));
  }
  function importProfile() {
    try {
      const value = JSON.parse(text);
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !Object.hasOwn(defaultProfile, key))) {
        throw new Error('Profile must be an object containing session settings only.');
      }
      const p = { ...defaults, ...value };
      if (
        typeof p.name !== 'string' ||
        !['arch', 'debian', 'ubuntu'].includes(p.distribution) ||
        !Array.isArray(p.packages) ||
        p.packages.some(item => typeof item !== 'string' || /\s/.test(item)) ||
        !Array.isArray(p.docker_args) ||
        p.docker_args.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg)) ||
        typeof p.startup_command !== 'string' ||
        typeof p.kiosk !== 'boolean' ||
        typeof p.gpu_access !== 'boolean' ||
        typeof p.software_encoding !== 'boolean'
      ) {
        throw new Error('Invalid profile field types.');
      }
      if (
        p.screen_size !== null &&
        (typeof p.screen_size !== 'object' ||
          Array.isArray(p.screen_size) ||
          Object.keys(p.screen_size).some(key => !['width', 'height'].includes(key)) ||
          ![p.screen_size.width, p.screen_size.height].every(n => Number.isInteger(n) && n >= 2 && n <= 8192 && n % 2 === 0))
      ) {
        throw new Error('Screen dimensions must be even numbers between 2 and 8192.');
      }
      if (p.gpu_access && !gpuAvailable) throw new Error('GPU access requires the host render node.');
      p.software_encoding ||= !p.gpu_access;
      setProfile(p);
      setPackages(p.packages.join(' '));
      setDockerArgs(p.docker_args.join('\n'));
      const size = p.screen_size;
      const preset = size ? `${size.width}x${size.height}` : 'dynamic';
      setScreen(size && !screenPresets.includes(preset) ? 'custom' : preset);
      setWidth(size?.width ?? 1920);
      setHeight(size?.height ?? 1080);
      setImportError('');
      setText('');
    } catch (e) {
      setImportError(e.message);
    }
  }
  return (
    <form
      onSubmit={async event => {
        event.preventDefault();
        if (text.trim()) {
          importPanel.current.open = true;
          setImportError(message => message || 'Apply or clear the pasted profile before creating a session.');
          return;
        }
        setPending(true);
        const size =
          screen === 'dynamic'
            ? null
            : screen === 'custom'
              ? { width: Number(width), height: Number(height) }
              : { width: Number(screen.split('x')[0]), height: Number(screen.split('x')[1]) };
        try {
          await submit({
            ...profile,
            packages: packages.trim().split(/\s+/).filter(Boolean),
            docker_args: (administrator ? dockerArgs : '').split('\n').map(line => line.trim()).filter(Boolean),
            screen_size: size,
            software_encoding: profile.software_encoding || !profile.gpu_access,
          });
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-5">
        {!initial && (
          <Disclosure label="Import Profile" panelRef={importPanel}>
            <div className="flex flex-col gap-4 p-4">
              <Field label="Profile JSON">
              <textarea
                rows={6}
                value={text}
                onChange={e => {
                  setText(e.target.value);
                  setImportError('');
                }}
                spellCheck={false}
                className="input min-h-28 resize-y py-2 font-mono text-xs"
              />
            </Field>
              <button type="button" className="btn btn-outline btn-sm self-start" onClick={importProfile}>
                Apply Profile
              </button>
            </div>
          </Disclosure>
        )}
        {importError && <Alert>{importError}</Alert>}

        <Section title="Basics">
          <div className="flex flex-col gap-4 p-4">
            <Field label="Session name">
              <input
                className="input"
                name="name"
                required
                maxLength={80}
                placeholder="My desktop"
                autoFocus
                value={profile.name}
                onChange={e => change('name', e.target.value)}
              />
            </Field>
            <Field label="Distribution" hint={initial ? 'The distribution is set at creation.' : undefined}>
              <select
                className="select select-md w-full"
                disabled={!!initial}
                name="distribution"
                value={profile.distribution}
                onChange={e => change('distribution', e.target.value)}
              >
                <option value="arch">Arch Linux · rolling base</option>
                <option value="debian">Debian 13 · Trixie</option>
                <option value="ubuntu">Ubuntu 26.04 LTS · Resolute</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Software">
          <div className="p-4">
            <Field
              label="Extra packages"
              hint={initial ? 'Packages are set at creation. Create a new session to change them.' : 'Optional. Separate package names with spaces.'}
            >
              <textarea
                className="input min-h-16 resize-y py-2 font-mono text-xs"
                readOnly={!!initial}
                name="packages"
                rows={3}
                placeholder="firefox foot"
                value={packages}
                onChange={e => setPackages(e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Display">
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2.5 text-sm text-ink">
                <input type="checkbox" className="check" name="gpu_access" checked={profile.gpu_access}
                  disabled={!!initial || (!gpuAvailable && !profile.gpu_access)}
                  onChange={e => setProfile(p => ({ ...p, gpu_access: e.target.checked, software_encoding: p.software_encoding || !e.target.checked }))} />
                GPU access
              </label>
              <p className="text-xs text-ink-3">{initial ? 'GPU access is set at creation.' : gpuAvailable ? 'Let the desktop and applications use the host GPU. Set at creation.' : 'The host render node is unavailable.'}</p>
              <label className="flex items-center gap-2.5 text-sm text-ink">
                <input type="checkbox" className="check" name="software_encoding" checked={profile.software_encoding || !profile.gpu_access}
                  disabled={!profile.gpu_access} onChange={e => change('software_encoding', e.target.checked)} />
                Software video encoding
              </label>
              <p className="text-xs text-ink-3">Use CPU encoders for the viewer stream. The desktop runs at 30 Hz. Applies on Start or Relaunch; required without GPU access.</p>
            </div>
            <Field label="Screen size">
              <select className="select select-md w-full" value={screen} onChange={e => setScreen(e.target.value)}>
                <option value="dynamic">Dynamic</option>
                {screenPresets.map(size => (
                  <option key={size} value={size}>
                    {size.replace('x', ' × ')}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </Field>
            {screen === 'custom' && (
              <div className="flex gap-4">
                <Field label="Width" className="min-w-0 flex-1">
                  <input className="input" type="number" required min={2} max={8192} step={2} value={width} onChange={e => setWidth(e.target.value)} />
                </Field>
                <Field label="Height" className="min-w-0 flex-1">
                  <input className="input" type="number" required min={2} max={8192} step={2} value={height} onChange={e => setHeight(e.target.value)} />
                </Field>
              </div>
            )}
            <label className="flex items-center gap-2.5 text-sm text-ink">
              <input type="checkbox" className="check" checked={profile.kiosk} onChange={e => change('kiosk', e.target.checked)} />
              Kiosk mode
            </label>
          </div>
        </Section>

        <Section title="Startup">
          <div className="p-4">
            <Field label="Startup command">
              <textarea
                className="input min-h-14 resize-y py-2 font-mono text-xs"
                rows={2}
                maxLength={4096}
                placeholder="0ad"
                value={profile.startup_command}
                onChange={e => change('startup_command', e.target.value)}
              />
            </Field>
          </div>
        </Section>

        {(administrator || initial) && (
          <Disclosure label="Advanced Docker Options">
            <div className="p-4">
              <Field
              label="Docker options"
              hint={
                initial
                  ? 'Docker options are set at creation. Create a new session to change them.'
                  : 'Optional. One --flag=value per line. Supports --security-opt, --cap-add, and --cap-drop. Repeated options are allowed.'
              }
            >
              <textarea
                className="input min-h-20 resize-y py-2 font-mono text-xs"
                name="docker_args"
                rows={4}
                readOnly={!!initial}
                value={dockerArgs}
                onChange={e => setDockerArgs(e.target.value)}
                placeholder={'--security-opt=seccomp=unconfined\n--security-opt=apparmor=unconfined\n--cap-add=SYS_ADMIN'}
              />
              </Field>
            </div>
          </Disclosure>
        )}

        {error && <Alert>{error}</Alert>}

        <FormActions note={blocked || note}>
          <Link to={cancelTo} className="btn btn-outline btn-sm">
            Cancel
          </Link>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!blocked}>
            {initial ? 'Save Changes' : 'Create Session'}
          </button>
        </FormActions>
      </fieldset>
    </form>
  );
}
