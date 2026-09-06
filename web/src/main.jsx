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
  const [token, setToken] = useState(
    () => sessionStorage.getItem("bwm-token") || "",
  );
  const [authenticated, setAuthenticated] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [layout, setLayout] = useState(
    () => localStorage.getItem("bwm-layout") || "grid",
  );
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
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
    setAuthenticated(true);
    sessionStorage.setItem("bwm-token", token);
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
    localStorage.setItem("bwm-layout", layout);
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
        <h1>Browser Wayland Manager</h1>
        <p>Enter the administrator token from the manager’s data directory.</p>
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
            Browser Wayland <strong>Manager</strong>
          </span>
        </div>
        <button
          onClick={() => {
            currentToken.current = "";
            sessionStorage.removeItem("bwm-token");
            setToken("");
            setAuthenticated(false);
            setLogs(null);
            setCreating(false);
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
                  {s.error && <p className="error">{s.error}</p>}
                  <div className="actions">
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
        <footer>Browser Wayland Manager</footer>
      </main>
      {creating && (
        <Dialog title="New session" close={() => setCreating(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const data = new FormData(form);
              const button = form.querySelector("button[type=submit]");
              button.disabled = true;
              setCreateError("");
              try {
                await api("/sessions", {
                  method: "POST",
                  body: JSON.stringify({
                    name: data.get("name"),
                    distribution: data.get("distribution"),
                    packages: data
                      .get("packages")
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean),
                  }),
                });
                setCreating(false);
                await refresh();
              } catch (e) {
                setCreateError(e.message);
              } finally {
                button.disabled = false;
              }
            }}
          >
            <label>
              Session name
              <input
                name="name"
                required
                maxLength={80}
                placeholder="My desktop"
                autoFocus
              />
            </label>
            <label>
              Distribution
              <select name="distribution">
                <option value="arch">Arch Linux · rolling base</option>
                <option value="debian">Debian 13 · Trixie</option>
              </select>
            </label>
            <label>
              Extra packages
              <textarea name="packages" rows={3} placeholder="firefox foot" />
              <small>Optional. Separate package names with spaces.</small>
            </label>
            {createError && (
              <p role="alert" className="error">
                {createError}
              </p>
            )}
            <button type="submit" className="primary">
              Create session
            </button>
          </form>
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
createRoot(document.getElementById("root")).render(<App />);
