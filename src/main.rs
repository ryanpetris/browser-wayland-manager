use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{
    process::Command,
    sync::{Mutex, Semaphore},
};
use uuid::Uuid;

const ELSEWHERE_VERSION: &str = env!("ELSEWHERE_VERSION");
const LABEL: &str = "io.innkeeper.owner";
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Session {
    id: String,
    name: String,
    distribution: String,
    packages: Vec<String>,
    #[serde(default)]
    startup_command: String,
    #[serde(default)]
    screen_size: Option<ScreenSize>,
    #[serde(default)]
    kiosk: bool,
    port: u16,
    #[serde(default)]
    started_ms: u64,
    status: String,
    stage: String,
    error: Option<String>,
    token: String,
    viewer_token: String,
    #[serde(default)]
    timings: HashMap<String, u64>,
}
#[derive(Serialize, Deserialize)]
struct Database {
    owner: String,
    sessions: Vec<Session>,
}
struct App {
    db: Mutex<Database>,
    dir: PathBuf,
    secret: String,
    public_host: String,
    docker_host: String,
    bind: String,
    assets: PathBuf,
    client: reqwest::Client,
    preparations: Semaphore,
    operations: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    previews: Semaphore,
    preview_times: Mutex<HashMap<String, Instant>>,
}
type Shared = Arc<App>;
struct Error(StatusCode, String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}
type Api<T> = std::result::Result<T, Error>;
fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}
fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn private_write(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(temp, path)?;
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}
impl App {
    fn save(&self, db: &Database) -> Result<()> {
        private_write(
            &self.dir.join("state.json"),
            &serde_json::to_vec_pretty(db)?,
        )
    }
    async fn session(&self, id: &str) -> Api<Session> {
        self.db
            .lock()
            .await
            .sessions
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or(Error(StatusCode::NOT_FOUND, "Session not found".into()))
    }
    async fn lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.operations
            .lock()
            .await
            .entry(id.into())
            .or_default()
            .clone()
    }
    async fn change(&self, id: &str, f: impl FnOnce(&mut Session)) -> Result<()> {
        let mut db = self.db.lock().await;
        if let Some(s) = db.sessions.iter_mut().find(|s| s.id == id) {
            let before = s.clone();
            f(s);
            if *s != before {
                self.save(&db)?;
            }
        }
        Ok(())
    }
    async fn owned(&self, id: &str) -> Result<serde_json::Value> {
        let raw = docker(&["inspect", &container(id)]).await?;
        let v: serde_json::Value = serde_json::from_str(&raw)?;
        if v[0]["Config"]["Labels"][LABEL].as_str() != Some(&self.db.lock().await.owner) {
            bail!("Container ownership does not match");
        }
        Ok(v[0].clone())
    }
    fn endpoint(&self, s: &Session) -> String {
        format!("https://{}:{}", self.docker_host, s.port)
    }
}
fn container(id: &str) -> String {
    format!("innkeeper-{id}")
}
fn volume(id: &str) -> String {
    format!("innkeeper-{id}-data")
}
async fn docker(args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(90),
        Command::new("docker")
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("Docker command timed out")??;
    if !output.status.success() {
        bail!("Docker: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
async fn auth(State(app): State<Shared>, req: axum::extract::Request, next: Next) -> Response {
    let supplied = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    if !bool::from(supplied.as_bytes().ct_eq(app.secret.as_bytes())) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
fn public_session(s: &Session) -> serde_json::Value {
    serde_json::json!({"id":s.id,"name":s.name,"distribution":s.distribution,"packages":s.packages,"startup_command":s.startup_command,"screen_size":s.screen_size,"kiosk":s.kiosk,"port":s.port,"status":s.status,"stage":s.stage,"error":s.error,"timings":s.timings})
}
async fn list(State(app): State<Shared>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"sessions":app.db.lock().await.sessions.iter().map(public_session).collect::<Vec<_>>(),"version":env!("INNKEEPER_VERSION")}),
    )
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ScreenSize {
    width: u32,
    height: u32,
}
impl ScreenSize {
    fn valid(self) -> bool {
        [self.width, self.height]
            .iter()
            .all(|n| (2..=8192).contains(n) && n % 2 == 0)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
    distribution: String,
    packages: Vec<String>,
    #[serde(default)]
    startup_command: String,
    #[serde(default)]
    screen_size: Option<ScreenSize>,
    #[serde(default)]
    kiosk: bool,
}
fn valid_package(p: &str) -> bool {
    !p.is_empty()
        && !p.ends_with('-')
        && p.len() <= 128
        && p.as_bytes()[0].is_ascii_alphanumeric()
        && p.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@._+:-".contains(&b))
}
async fn create(State(app): State<Shared>, Json(input): Json<Create>) -> Api<impl IntoResponse> {
    if !["arch", "debian"].contains(&input.distribution.as_str())
        || input.name.trim().is_empty()
        || input.name.chars().count() > 80
        || input.packages.len() > 100
        || !input.packages.iter().all(|p| valid_package(p))
    {
        return Err(Error(StatusCode::BAD_REQUEST, "Choose Arch or Debian, a name of 1–80 characters, and up to 100 valid package names. Shell syntax and options are not allowed.".into()));
    }
    if input.screen_size.is_some_and(|size| !size.valid()) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "Screen dimensions must be even numbers between 2 and 8192.".into(),
        ));
    }
    if input.startup_command.len() > 4096 || input.startup_command.contains('\0') {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "Startup command must be at most 4096 bytes and contain no NUL characters.".into(),
        ));
    }
    let mut db = app.db.lock().await;
    let port = (19500..20000)
        .find(|p| db.sessions.iter().all(|s| s.port != *p))
        .ok_or(Error(
            StatusCode::CONFLICT,
            "Session port range is full".into(),
        ))?;
    let s = Session {
        id: Uuid::new_v4().to_string(),
        name: input.name.trim().into(),
        distribution: input.distribution,
        packages: input.packages,
        startup_command: input.startup_command,
        screen_size: input.screen_size,
        kiosk: input.kiosk,
        port,
        started_ms: 0,
        status: "preparing".into(),
        stage: "download".into(),
        error: None,
        token: random_token(),
        viewer_token: random_token(),
        timings: HashMap::new(),
    };
    db.sessions.push(s.clone());
    app.save(&db)?;
    drop(db);
    let id = s.id.clone();
    tokio::spawn(async move {
        if let Err(e) = prepare(app.clone(), &id).await {
            let _ = app
                .change(&id, |s| {
                    if s.status == "preparing" {
                        s.status = "failed".into();
                        s.error = Some(redact(&e.to_string(), s));
                    }
                })
                .await;
        }
    });
    Ok((StatusCode::ACCEPTED, Json(public_session(&s))))
}
async fn prepare(app: Shared, id: &str) -> Result<()> {
    let initial = app.session(id).await.map_err(|e| anyhow::anyhow!(e.1))?;
    let version = ELSEWHERE_VERSION;
    let architecture = docker(&["info", "--format", "{{.Architecture}}"]).await?;
    if !matches!(architecture.trim(), "x86_64" | "amd64") {
        bail!("Release packages currently support only x86_64 Docker hosts");
    }
    let (image, asset) = if initial.distribution == "arch" {
        (
            "archlinux:base",
            format!("elsewhere-{version}-1-x86_64.pkg.tar.zst"),
        )
    } else {
        (
            "debian:trixie-slim",
            format!("elsewhere_{version}-1_amd64.deb"),
        )
    };
    let package = app
        .dir
        .join("packages")
        .join(version)
        .join("x86_64")
        .join(&initial.distribution)
        .join(&asset);
    let url = format!(
        "https://github.com/ryanpetris/elsewhere/releases/download/v{}/{}",
        version, asset
    );
    let started = Instant::now();
    if !package.metadata().is_ok_and(|m| m.len() > 0)
        || docker(&["image", "inspect", image]).await.is_err()
    {
        private_write(
            &app.dir.join(format!("{id}.build.log")),
            b"Waiting for release download and base image preparation.\n",
        )?;
        let _preparation = app.preparations.acquire().await?;
        if app
            .session(id)
            .await
            .map(|s| s.status != "preparing")
            .unwrap_or(true)
        {
            return Ok(());
        }
        if !package.metadata().is_ok_and(|m| m.len() > 0)
            || docker(&["image", "inspect", image]).await.is_err()
        {
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(app.dir.join(format!("{id}.build.log")))?;
            log.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            let mut child = Command::new("sh")
                .arg(app.assets.join("sessions/prepare.sh"))
                .arg(&url)
                .arg(&package)
                .arg(image)
                .stdout(log.try_clone()?)
                .stderr(log)
                .process_group(0)
                .kill_on_drop(true)
                .spawn()?;
            let pid = child.id().context("Preparation process has no ID")?;
            let deadline = Instant::now() + Duration::from_secs(1800);
            loop {
                tokio::select! {
                    status = child.wait() => {
                        if !status?.success() { bail!("Release download or base image pull failed. Open Logs for details."); }
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {
                        let cancelled = app.session(id).await.map(|s| s.status != "preparing").unwrap_or(true);
                        if cancelled || Instant::now() >= deadline {
                            // This process group belongs only to this session preparation.
                            unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
                            if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
                                unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                                let _ = child.wait().await;
                            }
                            if cancelled { return Ok(()); }
                            bail!("Session preparation timed out. Open Logs for details.");
                        }
                    }
                }
            }
        }
    }
    let lock = app.lock(id).await;
    let _guard = lock.lock().await;
    let s = app.session(id).await.map_err(|e| anyhow::anyhow!(e.1))?;
    if s.status != "preparing" {
        return Ok(());
    }
    app.change(id, |s| {
        s.stage = "container".into();
        s.timings
            .insert("download".into(), started.elapsed().as_millis() as u64);
    })
    .await?;
    let container_started = Instant::now();
    let owner = app.db.lock().await.owner.clone();
    let label = format!("{LABEL}={owner}");
    docker(&["volume", "create", "--label", &label, &volume(id)]).await?;
    let tcp = format!("{}:{}:19443/tcp", app.bind, s.port);
    let udp = format!("{}:{}:19443/udp", app.bind, s.port);
    let mount = format!("{}:/home/elsewhere", volume(id));
    let screen_size = format!(
        "INNKEEPER_SCREEN_SIZE={}",
        s.screen_size
            .map(|size| format!("{}x{}", size.width, size.height))
            .unwrap_or_default()
    );
    let kiosk = format!("INNKEEPER_KIOSK={}", u8::from(s.kiosk));
    let startup_command = format!("INNKEEPER_STARTUP_COMMAND={}", s.startup_command);
    let mut args = vec![
        "create",
        "--env",
        &screen_size,
        "--env",
        &kiosk,
        "--env",
        &startup_command,
        "--name",
        &container(id),
        "--label",
        &label,
        "--init",
        "--shm-size",
        "1g",
        "--log-opt",
        "max-size=10m",
        "--log-opt",
        "max-file=3",
        "-p",
        &tcp,
        "-p",
        &udp,
        "-v",
        &mount,
        "--platform",
        "linux/amd64",
        "--entrypoint",
        "sh",
        image,
        "/opt/innkeeper/entrypoint.sh",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if std::path::Path::new("/dev/dri/renderD128").exists() {
        args.splice(
            1..1,
            ["--device".to_owned(), "/dev/dri:/dev/dri".to_owned()],
        );
    }
    args.extend(s.packages.iter().cloned());
    docker(&args.iter().map(String::as_str).collect::<Vec<_>>()).await?;
    docker(&[
        "cp",
        app.assets
            .join("sessions")
            .to_str()
            .context("Invalid assets path")?,
        &format!("{}:/opt/innkeeper", container(id)),
    ])
    .await?;
    docker(&[
        "cp",
        package.to_str().context("Invalid package path")?,
        &format!("{}:/opt/innkeeper/{}", container(id), asset),
    ])
    .await?;
    docker(&[
        "cp",
        app.assets
            .join(format!("sessions/setup-{}.sh", s.distribution))
            .to_str()
            .context("Invalid assets path")?,
        &format!("{}:/opt/innkeeper/setup.sh", container(id)),
    ])
    .await?;
    let seed = app.dir.join(format!("{id}.seed"));
    std::fs::create_dir_all(&seed)?;
    std::fs::set_permissions(&seed, std::fs::Permissions::from_mode(0o700))?;
    private_write(&seed.join("token"), s.token.as_bytes())?;
    private_write(&seed.join("viewer-token"), s.viewer_token.as_bytes())?;
    let result = docker(&[
        "cp",
        seed.to_str().context("Invalid data path")?,
        &format!("{}:/seed", container(id)),
    ])
    .await;
    std::fs::remove_dir_all(seed)?;
    result?;
    app.change(id, |s| s.started_ms = now_ms()).await?;
    docker(&["start", &container(id)]).await?;
    app.change(id, |s| {
        s.timings.insert(
            "container".into(),
            container_started.elapsed().as_millis() as u64,
        );
    })
    .await?;
    Ok(())
}
fn redact(text: &str, s: &Session) -> String {
    text.replace(&s.token, "[REDACTED]")
        .replace(&s.viewer_token, "[REDACTED]")
}
async fn reconcile(app: Shared) {
    loop {
        let sessions = app.db.lock().await.sessions.clone();
        for s in sessions {
            let lock = app.lock(&s.id).await;
            let Ok(_guard) = lock.try_lock() else {
                continue;
            };
            if matches!(s.stage.as_str(), "image" | "download") {
                continue;
            }
            let Ok(s) = app.session(&s.id).await else {
                continue;
            };
            let inspect = match app.owned(&s.id).await {
                Ok(v) => v,
                Err(e) => {
                    let _ = app
                        .change(&s.id, |s| {
                            s.status = "failed".into();
                            s.error = Some(redact(&e.to_string(), s));
                        })
                        .await;
                    continue;
                }
            };
            let running = inspect["State"]["Running"].as_bool() == Some(true);
            if s.status == "running" && running {
                if s.error.is_some() {
                    let _ = app.change(&s.id, |s| s.error = None).await;
                }
                continue;
            }
            if !running {
                let code = inspect["State"]["ExitCode"].as_i64().unwrap_or(-1);
                let normal = [0, 137, 143].contains(&code) && inspect["State"]["OOMKilled"] != true;
                if s.status == "stopped" && normal && s.error.is_none() {
                    continue;
                }
                if s.status == "failed"
                    && s.error.as_deref()
                        == Some(&format!(
                            "Container exited with code {code} during {}. Open Logs for details.",
                            s.stage
                        ))
                {
                    continue;
                }
            }
            let stage_path = app.dir.join(format!("{}.stage", s.id));
            let stage = if docker(&[
                "cp",
                &format!("{}:/tmp/innkeeper-stage", container(&s.id)),
                stage_path.to_str().unwrap(),
            ])
            .await
            .is_ok()
            {
                let text = std::fs::read_to_string(&stage_path).unwrap_or_default();
                let _ = std::fs::remove_file(stage_path);
                text.trim().to_owned()
            } else {
                s.stage.clone()
            };
            if !running && inspect["State"]["Status"] == "created" {
                let _=app.change(&s.id,|s| {s.status="failed".into();s.error=Some("Container initialization was interrupted. Destroy this session and create it again.".into());}).await;
                continue;
            }
            if !running {
                let code = inspect["State"]["ExitCode"].as_i64().unwrap_or(-1);
                let normal = [0, 137, 143].contains(&code) && inspect["State"]["OOMKilled"] != true;
                let _ = app.change(&s.id, |s| {
                    s.stage = stage;
                    s.status = if normal { "stopped" } else { "failed" }.into();
                    s.error = if normal {None} else {Some(format!("Container exited with code {code} during {}. Open Logs for details.", s.stage))};
                }).await;
                continue;
            }
            let ready = if stage == "launch" {
                app.client
                    .get(format!("{}/api/windows", app.endpoint(&s)))
                    .bearer_auth(&s.viewer_token)
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false)
            } else {
                false
            };
            let timings = docker(&["exec", &container(&s.id), "cat", "/tmp/innkeeper-timings"])
                .await
                .unwrap_or_default();
            let entries = timings
                .lines()
                .filter_map(|l| {
                    let (a, b) = l.split_once(' ')?;
                    Some((a.parse::<u64>().ok()?, b.to_owned()))
                })
                .collect::<Vec<_>>();
            let _ = app
                .change(&s.id, |s| {
                    if !stage.is_empty() {
                        s.stage = stage.clone();
                    }
                    for pair in entries.windows(2) {
                        s.timings
                            .insert(pair[0].1.clone(), pair[1].0.saturating_sub(pair[0].0));
                    }
                    s.status = "preparing".into();
                    s.error = None;
                    if ready {
                        if let Some((launch, _)) = entries.last() {
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_millis() as u64;
                            s.timings
                                .insert("readiness".into(), now.saturating_sub(*launch));
                        }
                        s.status = "running".into();
                        s.stage = "ready".into();
                        s.error = None;
                    } else if let Some((since, _)) = entries.last() {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64;
                        if *since >= s.started_ms
                            && now.saturating_sub(*since)
                                > if stage == "launch" {
                                    120_000
                                } else {
                                    1_800_000
                                }
                        {
                            s.status = "failed".into();
                            s.error = Some(format!(
                                "{} timed out. Stop or destroy the session; Logs has the output.",
                                s.stage
                            ));
                        }
                    }
                })
                .await;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
async fn stop(State(app): State<Shared>, Path(id): Path<String>) -> Api<StatusCode> {
    let lock = app.lock(&id).await;
    let _guard = lock.lock().await;
    let s = app.session(&id).await?;
    if !matches!(s.stage.as_str(), "image" | "download") {
        let info = app.owned(&id).await?;
        if info["State"]["Running"] == true {
            docker(&["stop", "--time", "15", &container(&id)]).await?;
        }
    }
    app.change(&id, |s| {
        s.status = if matches!(s.stage.as_str(), "image" | "download") {
            "cancelled"
        } else {
            "stopped"
        }
        .into()
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn start(State(app): State<Shared>, Path(id): Path<String>) -> Api<StatusCode> {
    let lock = app.lock(&id).await;
    let _guard = lock.lock().await;
    let s = app.session(&id).await?;
    if s.status != "stopped" {
        return Err(Error(
            StatusCode::CONFLICT,
            "Only stopped sessions can be started".into(),
        ));
    }
    let info = app.owned(&id).await?;
    if info["State"]["Status"] == "created" {
        return Err(Error(
            StatusCode::CONFLICT,
            "Container initialization was interrupted. Destroy this session and create it again."
                .into(),
        ));
    }
    app.change(&id, |s| s.started_ms = now_ms()).await?;
    docker(&["start", &container(&id)]).await?;
    app.change(&id, |s| {
        s.status = "preparing".into();
        s.stage = "setup".into();
        s.error = None;
        s.timings
            .retain(|k, _| k == "image" || k == "download" || k == "container");
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn destroy(State(app): State<Shared>, Path(id): Path<String>) -> Api<StatusCode> {
    let lock = app.lock(&id).await;
    let _guard = lock.lock().await;
    app.session(&id).await?;
    let ids = docker(&[
        "ps",
        "-aq",
        "--filter",
        &format!("name=^/{}$", container(&id)),
    ])
    .await?;
    if !ids.trim().is_empty() {
        app.owned(&id).await?;
        docker(&["rm", "-f", &container(&id)]).await?;
    }
    let vols = docker(&[
        "volume",
        "ls",
        "-q",
        "--filter",
        &format!("name=^{}$", volume(&id)),
    ])
    .await?;
    if !vols.trim().is_empty() {
        let raw = docker(&["volume", "inspect", &volume(&id)]).await?;
        let v: serde_json::Value =
            serde_json::from_str(&raw).context("Invalid volume inspection")?;
        if v[0]["Labels"][LABEL].as_str() != Some(&app.db.lock().await.owner) {
            return Err(Error(
                StatusCode::CONFLICT,
                "Volume ownership does not match".into(),
            ));
        }
        docker(&["volume", "rm", &volume(&id)]).await?;
    }
    let mut db = app.db.lock().await;
    db.sessions.retain(|s| s.id != id);
    app.save(&db)?;
    let _ = std::fs::remove_file(app.dir.join(format!("{id}.build.log")));
    let _ = std::fs::remove_dir_all(app.dir.join(format!("{id}.seed")));
    let _ = std::fs::remove_file(app.dir.join(format!("{id}.stage")));
    app.preview_times.lock().await.remove(&id);
    // Keep the action mutex until outstanding requests have released their Arc.
    // Reusing a different mutex before then would let a stale request race cleanup.
    Ok(StatusCode::NO_CONTENT)
}
async fn link(State(app): State<Shared>, Path(id): Path<String>) -> Api<Json<serde_json::Value>> {
    let s = app.session(&id).await?;
    if s.status != "running" {
        return Err(Error(StatusCode::CONFLICT, "Session is not ready".into()));
    }
    Ok(Json(serde_json::json!({
        "url": format!("https://{}:{}/#token={}", if app.public_host.is_empty() { "localhost" } else { &app.public_host }, s.port, s.token),
        "use_browser_host": app.public_host.is_empty(),
    })))
}
async fn logs(State(app): State<Shared>, Path(id): Path<String>) -> Api<Json<serde_json::Value>> {
    let s = app.session(&id).await?;
    use std::io::{Read, Seek, SeekFrom};
    let mut output = String::new();
    if let Ok(mut file) = std::fs::File::open(app.dir.join(format!("{id}.build.log"))) {
        let len = file.metadata().context("Cannot read build log")?.len();
        file.seek(SeekFrom::Start(len.saturating_sub(128 * 1024)))
            .context("Cannot seek build log")?;
        let mut bytes = Vec::new();
        file.take(128 * 1024)
            .read_to_end(&mut bytes)
            .context("Cannot read build log")?;
        output.push_str(&String::from_utf8_lossy(&bytes));
    }
    if app.owned(&id).await.is_ok() {
        output.push_str("\n--- Container output ---\n");
        // The generated container name is a positional argument, never shell source.
        let raw = Command::new("sh")
            .args([
                "-c",
                "exec docker logs --tail 1000 \"$1\" 2>&1",
                "innkeeper-logs",
                &container(&id),
            ])
            .kill_on_drop(true)
            .output();
        if let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(10), raw).await {
            output.push_str(&String::from_utf8_lossy(&raw.stdout));
            output.push_str(&String::from_utf8_lossy(&raw.stderr));
        }
    }
    Ok(Json(serde_json::json!({"text":redact(&output,&s)})))
}
#[derive(Deserialize)]
struct Preview {
    width: u32,
}
async fn preview(
    State(app): State<Shared>,
    Path(id): Path<String>,
    Query(q): Query<Preview>,
) -> Api<Response> {
    if !(1..=1600).contains(&q.width) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "Preview width must be 1–1600".into(),
        ));
    }
    let s = app.session(&id).await?;
    if s.status != "running" {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Session is not running".into(),
        ));
    }
    let _permit = app.previews.try_acquire().map_err(|_| {
        Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Preview queue is full".into(),
        )
    })?;
    {
        let mut times = app.preview_times.lock().await;
        if times
            .get(&id)
            .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
        {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Preview refresh is limited to once every two seconds".into(),
            ));
        }
        times.insert(id, Instant::now());
    }
    let r = app
        .client
        .get(format!(
            "{}/api/screenshot.png?width={}",
            app.endpoint(&s),
            q.width
        ))
        .bearer_auth(&s.viewer_token)
        .send()
        .await
        .context("Screenshot unavailable")?;
    if !r.status().is_success() {
        return Err(Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Screenshot unavailable".into(),
        ));
    }
    let bytes = r.bytes().await.context("Screenshot interrupted")?;
    Ok(([(header::CONTENT_TYPE, "image/png")], bytes).into_response())
}
async fn asset(uri: axum::http::Uri) -> Response {
    let (data, kind): (&[u8], &str) = match uri.path() {
        "/" => (
            include_bytes!("../web/dist/index.html"),
            "text/html; charset=utf-8",
        ),
        "/app.js" => (include_bytes!("../web/dist/app.js"), "text/javascript"),
        "/app.css" => (include_bytes!("../web/dist/app.css"), "text/css"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    (
        [
            (header::CONTENT_TYPE, kind),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::CONTENT_SECURITY_POLICY, "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
        ],
        Body::from(data),
    )
        .into_response()
}
#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--version" || arg == "-V")
    {
        println!("elsewhere-innkeeper {}", env!("INNKEEPER_VERSION"));
        return Ok(());
    }
    let dir = PathBuf::from(env("INNKEEPER_DATA_DIR", "/var/lib/elsewhere-innkeeper"));
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    use std::os::fd::AsRawFd;
    let data_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("innkeeper.lock"))?;
    // The open file holds this exclusive lock for the lifetime of the server.
    if unsafe { libc::flock(data_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("Another Innkeeper is using this data directory");
    }
    let secret_path = dir.join("admin-token");
    let secret = if secret_path.exists() {
        std::fs::read_to_string(&secret_path)?.trim().to_owned()
    } else {
        let t = random_token();
        private_write(&secret_path, t.as_bytes())?;
        t
    };
    if secret.len() < 32 {
        bail!("Administrator token must be at least 32 characters");
    }
    let db_path = dir.join("state.json");
    let mut db: Database = if db_path.exists() {
        serde_json::from_slice(&std::fs::read(&db_path)?)?
    } else {
        Database {
            owner: Uuid::new_v4().to_string(),
            sessions: vec![],
        }
    };
    for s in &mut db.sessions {
        if s.status == "preparing" && matches!(s.stage.as_str(), "image" | "download") {
            s.status = "failed".into();
            s.error=Some("Innkeeper restarted during session preparation. Destroy this session and create it again.".into());
        }
    }
    let app = Arc::new(App {
        db: Mutex::new(db),
        dir,
        secret,
        public_host: env("INNKEEPER_PUBLIC_HOST", ""),
        docker_host: env("INNKEEPER_DOCKER_HOST", "127.0.0.1"),
        bind: env("INNKEEPER_SESSION_BIND", "0.0.0.0"),
        assets: PathBuf::from(env(
            "INNKEEPER_ASSETS_DIR",
            "/usr/share/elsewhere-innkeeper",
        )),
        client: reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(8))
            .build()?,
        preparations: Semaphore::new(1),
        operations: Mutex::new(HashMap::new()),
        previews: Semaphore::new(2),
        preview_times: Mutex::new(HashMap::new()),
    });
    if loopback(&app.bind) && !loopback(&app.docker_host) {
        bail!(
            "Loopback session binding requires a loopback INNKEEPER_DOCKER_HOST. In Compose use INNKEEPER_SESSION_BIND=0.0.0.0."
        );
    }
    app.save(&*app.db.lock().await)?;
    tokio::spawn(reconcile(app.clone()));
    let api = Router::new()
        .route("/sessions", get(list).post(create))
        .route("/sessions/{id}/stop", post(stop))
        .route("/sessions/{id}/start", post(start))
        .route("/sessions/{id}", axum::routing::delete(destroy))
        .route("/sessions/{id}/link", post(link))
        .route("/sessions/{id}/logs", get(logs))
        .route("/sessions/{id}/preview", get(preview))
        .layer(middleware::from_fn_with_state(app.clone(), auth));
    let router = Router::new()
        .nest("/api", api)
        .fallback(asset)
        .layer(DefaultBodyLimit::max(32 * 1024))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(env("INNKEEPER_LISTEN", "0.0.0.0:19300")).await?;
    eprintln!(
        "elsewhere-innkeeper listening on {}",
        listener.local_addr()?
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_boundary() {
        for p in [
            "firefox",
            "libgtk-3-0",
            "foo+bar",
            "libc6:amd64",
            "g++",
            "libstdc++-14-dev",
        ] {
            assert!(valid_package(p));
        }
        for p in [
            "", "-y", "--help", "x;id", "$(id)", "x y", "x\ny", "../x", "foo=1", "a/b", "dbus-",
        ] {
            assert!(!valid_package(p), "{p}");
        }
    }
    #[test]
    fn screen_sizes_and_profile_defaults() {
        for (width, height, valid) in [
            (1920, 1080, true),
            (2, 8192, true),
            (0, 720, false),
            (1281, 720, false),
            (1920, 8194, false),
        ] {
            assert_eq!(ScreenSize { width, height }.valid(), valid);
        }
        let profile: Create =
            serde_json::from_str(r#"{"name":"Desktop","distribution":"arch","packages":[]}"#)
                .unwrap();
        assert!(profile.screen_size.is_none());
        assert!(!profile.kiosk);
        assert!(profile.startup_command.is_empty());
        assert!(
            serde_json::from_str::<Create>(
                r#"{"name":"Desktop","distribution":"arch","packages":[],"kioks":true}"#
            )
            .is_err()
        );
    }
    #[test]
    fn tokens_are_redacted() {
        let s = Session {
            id: "".into(),
            name: "".into(),
            distribution: "".into(),
            packages: vec![],
            startup_command: String::new(),
            screen_size: None,
            kiosk: false,
            port: 0,
            started_ms: 0,
            status: "".into(),
            stage: "".into(),
            error: None,
            token: random_token(),
            viewer_token: random_token(),
            timings: HashMap::new(),
        };
        assert_eq!(s.token.len(), 64);
        assert_ne!(s.token, s.viewer_token);
        assert_eq!(
            redact(&format!("{} {}", s.token, s.viewer_token), &s),
            "[REDACTED] [REDACTED]"
        );
    }
}
