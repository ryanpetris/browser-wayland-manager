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
  const [token, setToken] = useState(
    () => sessionStorage.getItem("innkeeper-token") || "",
  );
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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (currentToken.current !== token) throw new Error("Session ended.");
    if (response.status === 401) {
      setAuthenticated(false);
      throw new Error("Enter a valid administrator token.");
    }
    if (!response.ok) {
      let body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response;
  }
  async function refresh(signal) {
    const response = await api("/sessions", { signal });
    const data = await response.json();
    if (currentToken.current !== token || signal?.aborted) return;
    setSessions(data.sessions);
    setVersion(data.version);
    setAuthenticated(true);
    sessionStorage.setItem("innkeeper-token", token);
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
  async function open(session) {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const r = await api(`/sessions/${session.id}/link`, { method: "POST" });
      const { url, use_browser_host } = await r.json();
      const destination = new URL(url);
      if (use_browser_host) destination.hostname = window.location.hostname;
      if (tab) tab.location.replace(destination.href);
      else throw new Error("Allow popups to open the session.");
    } catch (e) {
      tab?.close();
      setError(e.message);
    }
  }
  if (!authenticated)
    return (
      <main className="login">
        <Monitor size={36} />
        <h1>Elsewhere Innkeeper</h1>
        <p>Enter the administrator token from Innkeeper’s data directory.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            const next = e.currentTarget.token.value;
            if (next === token) refresh().catch((e) => setError(e.message));
            else setToken(next);
          }}
        >
          <label>
            Administrator token
            <input
              name="token"
              type="password"
              required
              autoComplete="current-password"
              defaultValue={token}
            />
          </label>
          <button className="primary">Sign in</button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </main>
    );
  return (
    <>
      <header>
        <div className="brand">
          <Monitor />
          <span>
            Elsewhere <strong>Innkeeper</strong>
          </span>
        </div>
        <button
          onClick={() => {
            currentToken.current = "";
            sessionStorage.removeItem("innkeeper-token");
            setToken("");
            setAuthenticated(false);
            setLogs(null);
            setCreating(false);
            setEditing(null);
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
                    {s.packages.length > 0 && (
                      <span className="muted"> · {s.packages.join(", ")}</span>
                    )}
                  </p>
                  {s.status === "preparing" && (
                    <p className="progress" role="status">
                      Preparing: {s.stage}…
                    </p>
                  )}
                  {s.settings_pending && (
                    <p role="status" className="muted">
                      Settings pending · {s.status === "stopped" ? "Applies on next start" : s.status === "preparing" ? "Applying on launch" : s.status === "failed" ? "Stop, then start to apply" : "Relaunch to apply"}
                    </p>
                  )}
                  {s.error && <p className="error">{s.error}</p>}
                  <div className="actions">
                    <button disabled={busy[s.id] || !["running", "stopped"].includes(s.status)}
                      onClick={() => { setEditError(""); setEditing(s); }}>
                      Edit settings
                    </button>
                    <button disabled={busy[s.id] || s.status !== "running"}
                      title="Restart with saved settings. Running applications will close."
                      onClick={() => action(s, "relaunch")}>
                      Relaunch
                    </button>
                    <button
                      disabled={s.status !== "running" || busy[s.id]}
                      onClick={() => open(s)}
                    >
                      <ExternalLink size={15} />
                      Open
                    </button>
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
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        <footer>
          Elsewhere Innkeeper <code>v{version}</code>
        </footer>
      </main>
      {creating && (
        <Dialog title="New session" close={() => setCreating(false)}>
          <SessionForm
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
  startup_command: "",
  screen_size: null,
  kiosk: false,
};
const screenPresets = ["1280x720", "1920x1080", "2560x1440", "3840x2160"];

function SessionForm({ submit, error, initial }) {
  const [profile, setProfile] = useState(initial || defaultProfile);
  const [packages, setPackages] = useState(initial?.packages.join(" ") || "");
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
