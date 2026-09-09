import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Grid2X2,
  List,
  Plus,
  Terminal,
  ExternalLink,
  Square,
  Trash2,
  LogOut,
  Monitor,
} from "lucide-react";
import "./style.css";

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
function App() {
  const [version, setVersion] = useState("");
  const [localElsewhere, setLocalElsewhere] = useState(false);
  const [token, setToken] = useState("");
  const [user, setUser] = useState(null);
  const [setupRequired, setSetupRequired] = useState(null);
  const [accountPanel, setAccountPanel] = useState(false);
  const [sharing, setSharing] = useState(null);
  const loginClock = useRef(null);
  function acceptLogin(data) {
    setUser(data.user); setToken(data.csrf_token); setAuthenticated(true);
    loginClock.current = {remaining: data.session_expires_at_ms - data.server_time_ms, at: performance.now()};
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch("/api/me");
        if (response.ok) { const data = await response.json(); if (live) acceptLogin(data); }
        else if (response.status === 401) {
          const setup = await fetch("/api/setup");
          if (!setup.ok) throw new Error("Account setup is unavailable.");
          const data = await setup.json(); if (live) setSetupRequired(data.required);
        } else throw new Error("Account service is unavailable.");
      } catch (e) { if (live) setError(e.message); }
    })();
    return () => { live = false; };
  }, []);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [layout, setLayout] = useState(
    () => localStorage.getItem("innkeeper-layout") || "grid",
  );
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState("");
  const [createError, setCreateError] = useState("");
  const logPane = useRef(null);
  const followLogs = useRef(true);
  const [logs, setLogs] = useState(null);
  const [logText, setLogText] = useState("Loading logs…");
  const [busy, setBusy] = useState({});
  const currentToken = useRef(token);
  currentToken.current = token;
  useEffect(() => {
    if (followLogs.current && logPane.current)
      logPane.current.scrollTop = logPane.current.scrollHeight;
  }, [logText]);
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      ...options,
      body: options.body ?? (options.method && options.method !== "GET" ? "{}" : undefined),
      headers: {
        "X-Innkeeper-CSRF": token,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (currentToken.current !== token) throw new Error("Session ended.");
    if (response.status === 401) {
      setAuthenticated(false);
      setUser(null); setToken(""); setSetupRequired(false);
      throw new Error("Your session has ended. Sign in again.");
    }
    if (!response.ok) {
      let body = await response.json().catch(() => ({}));
      throw new Error(body.message || body.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response;
  }
  async function refresh(signal) {
    const response = await api("/sessions", { signal });
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
    localStorage.setItem("innkeeper-layout", layout);
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
        const r = await api(`/sessions/${logs.id}/logs`, {
          signal: controller.signal,
        });
        const data = await r.json();
        if (live)
          setLogText(
            data.text.replace(/\x1b\[[0-9;]*m/g, "") || "Waiting for output…",
          );
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
    if (
      kind === "destroy" &&
      !confirm(
        `Destroy “${session.name}” and permanently delete its session data?`,
      )
    )
      return;
    setBusy((b) => ({ ...b, [session.id]: true }));
    setError("");
    try {
      await api(
        `/sessions/${session.id}${kind === "destroy" ? "" : `/${kind}`}`,
        { method: kind === "destroy" ? "DELETE" : "POST" },
      );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[session.id];
        return next;
      });
    }
  }
  function open(session) {
    window.open(`/api/sessions/${session.id}/connect`, "_blank", "noopener,noreferrer");
  }
  useEffect(() => {
    if (!token) return;
    let live = true, inflight = false;
    async function renew() {
      if (inflight || !live) return;
      inflight = true;
      try {
        const response = await api("/me");
        const data = await response.json();
        if (!live) return;
        setUser(data.user);
        if (data.csrf_token !== token) { setToken(data.csrf_token); return; }
        loginClock.current = {remaining: data.session_expires_at_ms - data.server_time_ms, at: performance.now()};
        if (loginClock.current.remaining > 0 && loginClock.current.remaining <= 2 * 86400000) {
          const renewal = await api("/session/renew", {method: "POST"});
          const renewed = await renewal.json();
          if (live) loginClock.current = {remaining: renewed.session_expires_at_ms - renewed.server_time_ms, at: performance.now()};
        }
      } catch (e) { if (live) setError(e.message); }
      finally { inflight = false; }
    }
    renew();
    const timer = setInterval(renew, 60000);
    window.addEventListener("focus", renew);
    window.addEventListener("online", renew);
    document.addEventListener("visibilitychange", renew);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", renew); window.removeEventListener("online", renew); document.removeEventListener("visibilitychange", renew); };
  }, [token]);
  if (!authenticated)
    return <Login required={setupRequired} error={error} submit={async (input) => {
      setError("");
      try {
        const response = await fetch(`/api/${setupRequired ? "setup" : "login"}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(input)});
        const data = await response.json();
        if (!response.ok) {
          if (data.error === "setup_complete") setSetupRequired(false);
          throw new Error(data.message || "Sign in failed.");
        }
        acceptLogin(data);
        const destination = new URLSearchParams(location.search).get("return");
        if (destination && /^\/api\/sessions\/[0-9a-f-]{36}\/connect$/.test(destination)) location.replace(destination);
      } catch (e) { setError(e.message); }
    }} />;
  return (
    <>
      <header>
        <div className="brand">
          <Monitor />
          <span>
            Elsewhere <strong>Innkeeper</strong>
          </span>
        </div>
        <button onClick={() => setAccountPanel(true)}>{user?.display_name}</button>
        <button
          onClick={async () => {
            try { await api("/logout", {method: "POST"}); }
            catch (e) { setError(e.message); return; }
            currentToken.current = "";
            setToken(""); setUser(null); setSetupRequired(false);
            setAuthenticated(false); setLogs(null); setCreating(false); setEditing(null); setSessions([]);
          }}
        >
          <LogOut size={16} />
          Sign out
        </button>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1>Sessions</h1>
            <p>Create a desktop. Open it anywhere.</p>
          </div>
          <button className="primary" onClick={() => setCreating(true)}>
            <Plus size={18} />
            New session
          </button>
        </div>
        {error && (
          <div role="alert" className="error">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        <div className="toolbar">
          <span>
            {sessions.filter((s) => s.status === "running").length} running{" "}
            <span className="muted">/ {sessions.length} total</span>
          </span>
          <div className="toggle">
            <button
              aria-label="Grid view"
              aria-pressed={layout === "grid"}
              onClick={() => setLayout("grid")}
            >
              <Grid2X2 size={18} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={layout === "list"}
              onClick={() => setLayout("list")}
            >
              <List size={18} />
            </button>
          </div>
        </div>
        {!sessions.length ? (
          <div className="empty">
            <Monitor size={44} />
            <h2>Your first desktop starts here</h2>
            <button onClick={() => setCreating(true)}>Create a session</button>
          </div>
        ) : (
          <div className={`sessions ${layout}`}>
            {sessions.map((s) => (
              <article key={s.id} className="session">
                <Preview session={s} layout={layout} api={api} />
                <div className="session-info">
                  <div className="session-title">
                    <h2>{s.name}</h2>
                    <span className={`status ${s.status}`}>{s.status}</span>
                  </div>
                  <p>
                    {s.distribution === "arch" ? "Arch Linux" : "Debian 13"}
                    {s.packages?.length > 0 && (
                      <span className="muted"> · {s.packages.join(", ")}</span>
                    )}
                  </p>
                  <p className={s.version_status === "newer" ? "warning" : "muted"}>
                    Elsewhere {s.installed_version || "version unavailable"}
                    {s.version_status === "older" && ` · ${s.expected_version} available`}
                    {s.version_status === "newer" && ` · Newer than expected (${s.expected_version})`}
                    {s.installed_version && s.version_status === "unknown" && " · Version comparison unavailable"}
                  </p>
                  {s.version_error && <p className="muted">{s.version_error}</p>}
                  {s.repair_available && <p className="muted">Elsewhere installation is incomplete. Repair installs the expected package and leaves the session stopped.</p>}
                  {["preparing", "upgrading"].includes(s.status) && (
                    <p className="progress" role="status">
                      {s.status === "upgrading" ? "Upgrading" : "Preparing"}: {s.stage}…
                    </p>
                  )}
                  {s.settings_pending && (
                    <p role="status" className="muted">
                      Settings pending · {["stopped", "upgrading"].includes(s.status) ? "Applies on next start" : s.status === "preparing" ? "Applying on launch" : s.status === "failed" ? "Stop, then start to apply" : "Relaunch to apply"}
                    </p>
                  )}
                  {s.version_status === "older" && <p className="muted">Upgrade closes running applications and leaves the session stopped.</p>}
                  {s.error && <p className="error">{s.error}</p>}
                  <div className="actions">
                    {user?.role === "administrator" && <button onClick={() => setSharing(s)}>Share</button>}
                    {s.access_role === "manager" && <>
                    <button disabled={busy[s.id] || !["running", "stopped"].includes(s.status)}
                      onClick={() => { setEditError(""); setEditing(s); }}>
                      Edit settings
                    </button>
                    {(s.version_status === "older" || s.repair_available) && (
                      <button disabled={busy[s.id] || !["running", "stopped"].includes(s.status)}
                        title="Install the expected Elsewhere version and leave the session stopped."
                        onClick={() => action(s, "upgrade")}>
                        {s.repair_available ? "Repair" : "Upgrade"}
                      </button>
                    )}
                    <button disabled={busy[s.id] || s.status !== "running"}
                      title="Restart with saved settings. Running applications will close."
                      onClick={() => action(s, "relaunch")}>
                      Relaunch
                    </button>
                    </>}
                    <button
                      disabled={s.status !== "running" || busy[s.id]}
                      onClick={() => open(s)}
                    >
                      <ExternalLink size={15} />
                      Open
                    </button>
                    {s.access_role === "manager" && <>
                    <button
                      onClick={() => {
                        followLogs.current = true;
                        setLogText("Loading logs…");
                        setLogs(s);
                      }}
                    >
                      <Terminal size={15} />
                      Logs
                    </button>
                    <button
                      disabled={busy[s.id] || s.status === "cancelled"}
                      onClick={() =>
                        action(s, s.status === "stopped" ? "start" : "stop")
                      }
                    >
                      <Square size={13} />
                      {s.status === "stopped" ? "Start" : "Stop"}
                    </button>
                    <button
                      className="danger"
                      disabled={busy[s.id]}
                      onClick={() => action(s, "destroy")}
                      aria-label={`Destroy ${s.name}`}
                    >
                      <Trash2 size={15} />
                    </button>
                    </>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        <footer>
          Elsewhere Innkeeper <code>v{version}</code>
          {localElsewhere && " · Local Elsewhere build"}
        </footer>
      </main>
      {accountPanel && <Accounts api={api} user={user} changed={setUser} close={() => setAccountPanel(false)} />}
      {sharing && <Sharing api={api} machine={sharing} close={() => setSharing(null)} />}
      {creating && (
        <Dialog title="New session" close={() => setCreating(false)}>
          <SessionForm administrator={user?.role === "administrator"}
            error={createError}
            submit={async (profile) => {
              setCreateError("");
              try {
                await api("/sessions", {
                  method: "POST",
                  body: JSON.stringify(profile),
                });
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
        <Dialog title="Edit settings" close={() => setEditing(null)}>
          <p className="muted">Save applies the name immediately. Other settings apply on the next launch. Relaunch closes running applications.</p>
          {(sessions.find((s) => s.id === editing.id) || editing).settings_pending && (
            <p role="status">Settings pending · Applies on next launch</p>
          )}
          <SessionForm key={editing.id} initial={editing} error={editError}
            submit={async (profile) => {
              setEditError("");
              try {
                await api(`/sessions/${editing.id}/settings`, {
                  method: "PUT",
                  body: JSON.stringify({name: profile.name, screen_size: profile.screen_size,
                    kiosk: profile.kiosk, startup_command: profile.startup_command}),
                });
                setEditing(null);
                await refresh();
              } catch (e) { setEditError(e.message); }
            }} />
        </Dialog>
      )}
      {logs && (
        <Dialog title={`Logs · ${logs.name}`} close={() => setLogs(null)} wide>
          <p className="muted">
            {Object.entries(
              (sessions.find((s) => s.id === logs.id) || logs).timings || {},
            )
              .map(([stage, ms]) => `${stage}: ${(ms / 1000).toFixed(2)}s`)
              .join(" · ")}
          </p>
          <pre
            ref={logPane}
            onScroll={(e) => {
              const node = e.currentTarget;
              followLogs.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
            className="logs"
            tabIndex={0}
          >
            {logText}
          </pre>
        </Dialog>
      )}
    </>
  );
}
function Dialog({ title, close, children, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? "wide" : ""}
      onCancel={close}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button onClick={close} aria-label="Close dialog">
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Preview({ session, layout, api }) {
  const ref = useRef(null);
  const [url, setUrl] = useState("");
  const urlRef = useRef("");
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  useEffect(() => {
    if (session.status !== "running") {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
      setUrl("");
    }
    let visible = false,
      disposed = false,
      inflight = false;
    const controller = new AbortController();
    async function capture() {
      if (
        disposed ||
        inflight ||
        !visible ||
        document.hidden ||
        session.status !== "running"
      )
        return;
      inflight = true;
      enqueuePreview(async () => {
        if (disposed || !visible || document.hidden) {
          inflight = false;
          return;
        }
        try {
          const width = Math.min(
            1600,
            Math.max(1, Math.ceil(ref.current.clientWidth * devicePixelRatio)),
          );
          const r = await api(
            `/sessions/${session.id}/preview?width=${width}`,
            { signal: controller.signal },
          );
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
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) capture();
    });
    observer.observe(ref.current);
    const timer = setInterval(capture, 5000);
    document.addEventListener("visibilitychange", capture);
    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", capture);
    };
  }, [session.id, session.status, layout]);
  return (
    <div ref={ref} className="preview">
      {url && session.status === "running" ? (
        <img src={url} alt={`Desktop preview of ${session.name}`} />
      ) : (
        <div>
          <Monitor size={28} />
          <span>
            {session.status === "running"
              ? "Preview unavailable"
              : session.status === "preparing"
                ? "Preparing desktop…"
                : "Desktop offline"}
          </span>
        </div>
      )}
    </div>
  );
}

const defaultProfile = {
  name: "",
  distribution: "arch",
  packages: [],
  docker_args: [],
  startup_command: "",
  screen_size: null,
  kiosk: false,
};
const screenPresets = ["1280x720", "1920x1080", "2560x1440", "3840x2160"];

function SessionForm({ submit, error, initial, administrator = false }) {
  const [profile, setProfile] = useState(initial || defaultProfile);
  const [packages, setPackages] = useState(initial?.packages.join(" ") || "");
  const [dockerArgs, setDockerArgs] = useState(initial?.docker_args?.join("\n") || "");
  const initialSize = initial?.screen_size;
  const initialPreset = initialSize ? `${initialSize.width}x${initialSize.height}` : "dynamic";
  const [screen, setScreen] = useState(initialSize && !screenPresets.includes(initialPreset) ? "custom" : initialPreset);
  const [width, setWidth] = useState(initialSize?.width ?? 1920);
  const [height, setHeight] = useState(initialSize?.height ?? 1080);
  const [text, setText] = useState("");
  const [importError, setImportError] = useState("");
  const importPanel = useRef(null);
  const [pending, setPending] = useState(false);
  function change(key, value) {
    setProfile((p) => ({ ...p, [key]: value }));
  }
  function importProfile() {
    try {
      const value = JSON.parse(text);
      if (
        !value ||
        Array.isArray(value) ||
        typeof value !== "object" ||
        Object.keys(value).some((key) => !Object.hasOwn(defaultProfile, key))
      ) {
        throw new Error(
          "Profile must be an object containing session settings only.",
        );
      }
      const p = { ...defaultProfile, ...value };
      if (
        typeof p.name !== "string" ||
        !["arch", "debian"].includes(p.distribution) ||
        !Array.isArray(p.packages) ||
        p.packages.some(
          (item) => typeof item !== "string" || /\s/.test(item),
        ) ||
        !Array.isArray(p.docker_args) ||
        p.docker_args.some((arg) => typeof arg !== "string" || /[\r\n\0]/.test(arg)) ||
        typeof p.startup_command !== "string" ||
        typeof p.kiosk !== "boolean"
      ) {
        throw new Error("Invalid profile field types.");
      }
      if (
        p.screen_size !== null &&
        (typeof p.screen_size !== "object" ||
          Array.isArray(p.screen_size) ||
          Object.keys(p.screen_size).some(
            (key) => !["width", "height"].includes(key),
          ) ||
          ![p.screen_size.width, p.screen_size.height].every(
            (n) => Number.isInteger(n) && n >= 2 && n <= 8192 && n % 2 === 0,
          ))
      ) {
        throw new Error(
          "Screen dimensions must be even numbers between 2 and 8192.",
        );
      }
      setProfile(p);
      setPackages(p.packages.join(" "));
      setDockerArgs(p.docker_args.join("\n"));
      const size = p.screen_size;
      const preset = size ? `${size.width}x${size.height}` : "dynamic";
      setScreen(size && !screenPresets.includes(preset) ? "custom" : preset);
      setWidth(size?.width ?? 1920);
      setHeight(size?.height ?? 1080);
      setImportError("");
      setText("");
    } catch (e) {
      setImportError(e.message);
    }
  }
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (text.trim()) {
          importPanel.current.open = true;
          setImportError(
            (message) =>
              message ||
              "Apply or clear the pasted profile before creating a session.",
          );
          return;
        }
        setPending(true);
        const size =
          screen === "dynamic"
            ? null
            : screen === "custom"
              ? { width: Number(width), height: Number(height) }
              : {
                  width: Number(screen.split("x")[0]),
                  height: Number(screen.split("x")[1]),
                };
        try {
          await submit({
            ...profile,
            packages: packages.trim().split(/\s+/).filter(Boolean),
            docker_args: (administrator ? dockerArgs : "").split("\n").map((line) => line.trim()).filter(Boolean),
            screen_size: size,
          });
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending} className="session-fields">
        {!initial && <details ref={importPanel} className="profile-import">
          <summary>Import profile</summary>
          <label>
            Profile JSON
            <textarea
              rows={6}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setImportError("");
              }}
            />
          </label>
          <button type="button" onClick={importProfile}>
            Apply profile
          </button>
        </details>}
        {importError && (
          <p role="alert" className="error">
            {importError}
          </p>
        )}
        <label>
          Session name
          <input
            name="name"
            required
            maxLength={80}
            placeholder="My desktop"
            autoFocus
            value={profile.name}
            onChange={(e) => change("name", e.target.value)}
          />
        </label>
        <label>
          Distribution
          <select
            disabled={!!initial}
            name="distribution"
            value={profile.distribution}
            onChange={(e) => change("distribution", e.target.value)}
          >
            <option value="arch">Arch Linux · rolling base</option>
            <option value="debian">Debian 13 · Trixie</option>
          </select>
        </label>
        <label>
          Extra packages
          <textarea
            readOnly={!!initial}
            name="packages"
            rows={3}
            placeholder="firefox foot"
            value={packages}
            onChange={(e) => setPackages(e.target.value)}
          />
          <small>{initial ? "Distribution and packages are set at creation." : "Optional. Separate package names with spaces."}</small>
        </label>
        {(administrator || initial) && <details>
          <summary>Advanced Docker options</summary>
          <label>
            Docker options
            <textarea
              name="docker_args"
              rows={4}
              readOnly={!!initial}
              value={dockerArgs}
              onChange={(e) => setDockerArgs(e.target.value)}
              placeholder={"--security-opt=seccomp=unconfined\n--security-opt=apparmor=unconfined\n--cap-add=SYS_ADMIN"}
            />
            <small>{initial ? "Docker options are set at creation. Create a new session to change them." : "Optional. One --flag=value per line. Supports --security-opt, --cap-add, and --cap-drop. Repeated options are allowed."}</small>
          </label>
        </details>}
        <label>
          Screen size
          <select value={screen} onChange={(e) => setScreen(e.target.value)}>
            <option value="dynamic">Dynamic</option>
            {screenPresets.map((size) => (
              <option key={size} value={size}>
                {size.replace("x", " × ")}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        {screen === "custom" && (
          <div className="screen-dimensions">
            <label>
              Width
              <input
                type="number"
                required
                min={2}
                max={8192}
                step={2}
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
            </label>
            <label>
              Height
              <input
                type="number"
                required
                min={2}
                max={8192}
                step={2}
                value={height}
                onChange={(e) => setHeight(e.target.value)}
              />
            </label>
          </div>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={profile.kiosk}
            onChange={(e) => change("kiosk", e.target.checked)}
          />
          Kiosk mode
        </label>
        <label>
          Startup command
          <textarea
            rows={2}
            maxLength={4096}
            placeholder="0ad"
            value={profile.startup_command}
            onChange={(e) => change("startup_command", e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="primary">
          {initial ? "Save" : "Create session"}
        </button>
      </fieldset>
    </form>
  );
}

createRoot(document.getElementById("root")).render(<App />);

function Login({required, error, submit}) {
  return <main className="login"><Monitor size={36}/><h1>Elsewhere Innkeeper</h1>
    <p>{required === null ? "Loading accounts…" : required ? "Create the first Administrator account." : "Sign in to your account."}</p>
    {required !== null && <form onSubmit={async e => {
      e.preventDefault(); const form = e.currentTarget; const fields = new FormData(form);
      const input = {username: fields.get("username"), password: fields.get("password")};
      if (required) { if (fields.get("confirmation") !== input.password) {form.confirmation.setCustomValidity("Passwords differ."); form.confirmation.reportValidity(); return;} input.display_name = fields.get("display_name"); }
      await submit(input);
    }}>
      <label>Username<input name="username" autoComplete="username" required maxLength={64}/></label>
      {required && <label>Display name<input name="display_name" autoComplete="name" required maxLength={120}/></label>}
      <label>Password<input type="password" name="password" autoComplete={required ? "new-password" : "current-password"} minLength={required ? 12 : undefined} required/></label>
      {required && <label>Confirm password<input type="password" name="confirmation" autoComplete="new-password" required onInput={e => e.target.setCustomValidity("")}/></label>}
      <button className="primary">{required ? "Create Administrator" : "Sign in"}</button>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
  </main>;
}
function Accounts({api,user,changed,close}) {
  const [users,setUsers] = useState([]), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  async function reload() {if (user.role === "administrator") setUsers((await (await api("/users")).json()).users);}
  useEffect(() => {reload().catch(e => setError(e.message));}, [user.role]);
  async function perform(work) {setBusy(true); setError(""); try {await work(); await reload();} catch(e) {setError(e.message);} finally {setBusy(false);} }
  return <Dialog title="Account" close={close}>
    {error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={e => {e.preventDefault();const display_name=e.currentTarget.display_name.value;perform(async () => {const result=await (await api("/me",{method:"PATCH",body:JSON.stringify({display_name})})).json();changed(result.user);});}}>
      <p>Username: {user.username}</p><label>Display name<input name="display_name" defaultValue={user.display_name} required maxLength={120}/></label><button disabled={busy}>Save display name</button>
    </form>
    <form onSubmit={e => {e.preventDefault();const data=new FormData(e.currentTarget);perform(async () => {await api("/me/password",{method:"PUT",body:JSON.stringify({current_password:data.get("current_password"),password:data.get("password")})});location.reload();});}}>
      <label>Current password<input type="password" name="current_password" autoComplete="current-password" required/></label>
      <label>New password<input type="password" name="password" autoComplete="new-password" minLength={12} required/></label><button disabled={busy}>Change password and sign out</button>
    </form>
    {user.role === "administrator" && <>
      <h3>Users</h3>
      {users.map(target => <form key={target.id + target.username + target.display_name + target.role + target.enabled} onSubmit={e => {e.preventDefault();const data=new FormData(e.currentTarget);perform(async () => {const result=await (await api(`/users/${target.id}`,{method:"PATCH",body:JSON.stringify({username:data.get("username"),display_name:data.get("display_name"),role:data.get("role"),enabled:data.get("enabled")==="on"})})).json();if (target.id === user.id) changed(result.user);});}}>
        <h4>{target.display_name}</h4>
        <label>Username<input name="username" defaultValue={target.username} required maxLength={64}/></label>
        <label>Display name<input name="display_name" defaultValue={target.display_name} required maxLength={120}/></label>
        <label>Account role<select name="role" defaultValue={target.role}><option value="user">User</option><option value="administrator">Administrator</option></select></label>
        <label><input type="checkbox" name="enabled" defaultChecked={target.enabled}/> Enabled</label>
        <button disabled={busy}>Save account</button>
        <button disabled={busy} type="button" onClick={() => perform(async () => {if(confirm(`Delete account ${target.display_name}?`)) await api(`/users/${target.id}`,{method:"DELETE"});})}>Delete account</button>
        <label>Reset password<input name="reset_password" type="password" autoComplete="new-password" minLength={12}/></label>
        <button type="button" disabled={busy} onClick={e => {const field=e.currentTarget.form.reset_password; if(!field.value || !field.reportValidity()) return;perform(async () => {await api(`/users/${target.id}/password`,{method:"PUT",body:JSON.stringify({password:field.value})});field.value="";});}}>Reset password</button>
      </form>)}
      <h3>Create user</h3>
      <form onSubmit={e => {e.preventDefault();const form=e.currentTarget;const data=new FormData(form);perform(async () => {await api("/users",{method:"POST",body:JSON.stringify(Object.fromEntries(data))});form.reset();});}}>
        <label>Username<input name="username" required maxLength={64} autoComplete="off"/></label>
        <label>Display name<input name="display_name" required maxLength={120}/></label>
        <label>Password<input name="password" type="password" minLength={12} autoComplete="new-password" required/></label>
        <label>Account role<select name="role"><option value="user">User</option><option value="administrator">Administrator</option></select></label>
        <button disabled={busy}>Create user</button>
      </form>
    </>}
  </Dialog>;
}
function Sharing({api,machine,close}) {
  const [users,setUsers]=useState([]),[assignments,setAssignments]=useState([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function reload(){const [u,a]=await Promise.all([api("/users").then(r=>r.json()),api(`/sessions/${machine.id}/access`).then(r=>r.json())]);setUsers(u.users);setAssignments(a.assignments);}
  useEffect(()=>{reload().catch(e=>setError(e.message));},[machine.id]);
  return <Dialog title={`Share ${machine.name}`} close={close}>
    <p>Administrators can always manage this machine.</p>{error && <p className="error" role="alert">{error}</p>}
    {users.map(user=><label key={user.id}>{user.display_name}{user.role === "administrator" ? " · Administrator" : ""}
      <select disabled={busy} value={assignments.find(a=>a.user_id===user.id)?.role || ""} onChange={async e=>{setBusy(true);setError("");const role=e.target.value;try{await api(`/sessions/${machine.id}/access/${user.id}`,{method:role?"PUT":"DELETE",body:role?JSON.stringify({role}):undefined});await reload();}catch(e){setError(e.message);}finally{setBusy(false);}}}>
        <option value="">No assignment</option><option value="viewer">Viewer · video and audio</option><option value="interactive">Interactive · use desktop</option><option value="manager">Manager · use and manage machine</option>
      </select>
    </label>)}
  </Dialog>;
}
