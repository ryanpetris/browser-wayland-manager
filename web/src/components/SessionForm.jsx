// The settings a session is created with, and the subset that can be changed afterwards.
import { useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Alert, Field } from './ui.jsx';

const defaultProfile = {
  name: '',
  distribution: 'arch',
  packages: [],
  docker_args: [],
  startup_command: '',
  screen_size: null,
  kiosk: false,
};
const screenPresets = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];

/// A disclosure panel that keeps the advanced settings out of the way.
function Panel({ label, panelRef, children }) {
  return (
    <details ref={panelRef} className="group card overflow-hidden">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-ink-2 transition-colors select-none hover:bg-surface-3 hover:text-ink">
        <ChevronRight className="size-3.5 shrink-0 text-ink-3 transition-transform group-open:rotate-90" strokeWidth={2} />
        {label}
      </summary>
      <div className="flex flex-col gap-3 border-t border-line p-3">{children}</div>
    </details>
  );
}

export function SessionForm({ submit, error, initial, administrator = false }) {
  const [profile, setProfile] = useState(initial || defaultProfile);
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
      const p = { ...defaultProfile, ...value };
      if (
        typeof p.name !== 'string' ||
        !['arch', 'debian'].includes(p.distribution) ||
        !Array.isArray(p.packages) ||
        p.packages.some(item => typeof item !== 'string' || /\s/.test(item)) ||
        !Array.isArray(p.docker_args) ||
        p.docker_args.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg)) ||
        typeof p.startup_command !== 'string' ||
        typeof p.kiosk !== 'boolean'
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
          });
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-4 p-4">
        {!initial && (
          <Panel label="Import profile" panelRef={importPanel}>
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
              Apply profile
            </button>
          </Panel>
        )}
        {importError && <Alert>{importError}</Alert>}
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
        <Field label="Distribution">
          <select
            className="select select-md w-full"
            disabled={!!initial}
            name="distribution"
            value={profile.distribution}
            onChange={e => change('distribution', e.target.value)}
          >
            <option value="arch">Arch Linux · rolling base</option>
            <option value="debian">Debian 13 · Trixie</option>
          </select>
        </Field>
        <Field
          label="Extra packages"
          hint={initial ? 'Distribution and packages are set at creation.' : 'Optional. Separate package names with spaces.'}
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
        {(administrator || initial) && (
          <Panel label="Advanced Docker options">
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
          </Panel>
        )}
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
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
          <input type="checkbox" className="check" checked={profile.kiosk} onChange={e => change('kiosk', e.target.checked)} />
          Kiosk mode
        </label>
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
        {error && <Alert>{error}</Alert>}
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-1 border-t border-line bg-surface px-4 py-3">
          <button type="submit" className="btn btn-primary h-9 w-full">
            {initial ? 'Save' : 'Create session'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
