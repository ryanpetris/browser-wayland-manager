use crate::{Api, Error, Json, Shared, login_store::LoginStore, now_ms, store::Store};
use anyhow::{Context, Result, ensure};
use argon2::{
    Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version,
    password_hash::SaltString,
};
use axum::{
    Router,
    extract::{ConnectInfo, Path, Request, State},
    http::{Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use axum_login::{AuthUser, AuthnBackend};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use time::OffsetDateTime;
use tower_sessions::{SessionStore, session::Expiry};

pub type Auth = axum_login::AuthSession<Backend>;
#[derive(Clone, Serialize)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub enabled: bool,
    pub created_at_ms: i64,
    #[serde(skip)]
    pub password_hash: String,
}
impl std::fmt::Debug for User {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("User")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}
impl AuthUser for User {
    type Id = String;
    fn id(&self) -> String {
        self.id.clone()
    }
    fn session_auth_hash(&self) -> &[u8] {
        self.password_hash.as_bytes()
    }
}
#[derive(Clone)]
pub struct Backend(pub Store);
#[derive(Debug)]
pub struct BackendError;
impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Account storage unavailable")
    }
}
impl std::error::Error for BackendError {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    username: String,
    password: String,
}
impl AuthnBackend for Backend {
    type User = User;
    type Credentials = Credentials;
    type Error = BackendError;
    async fn authenticate(
        &self,
        creds: Credentials,
    ) -> std::result::Result<Option<User>, BackendError> {
        let name = normalize_username(&creds.username).unwrap_or_default();
        let user = self
            .0
            .run(move |db| read_user(db, "username", &name))
            .await
            .map_err(|_| BackendError)?;
        let hash = user
            .as_ref()
            .map(|u| u.password_hash.clone())
            .unwrap_or_else(|| {
                DUMMY_HASH
                    .get()
                    .expect("Password worker initialized")
                    .clone()
            });
        let valid = verify(creds.password, hash)
            .await
            .map_err(|_| BackendError)?;
        Ok(user.filter(|u| valid && u.enabled))
    }
    async fn get_user(&self, id: &String) -> std::result::Result<Option<User>, BackendError> {
        let id = id.clone();
        self.0
            .run(move |db| read_user(db, "id", &id))
            .await
            .map(|u| u.filter(|u| u.enabled))
            .map_err(|_| BackendError)
    }
}
static HASH_WORKERS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
static DUMMY_HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
fn argon() -> Argon2<'static> {
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19456, 2, 1, Some(32)).unwrap(),
    )
}
pub async fn initialize() -> Result<()> {
    HASH_WORKERS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)));
    let hash = hash_password("dummy credential for verification".into()).await?;
    let _ = DUMMY_HASH.set(hash);
    Ok(())
}
pub fn valid_secret(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn valid_id(s: &str) -> Result<()> {
    let id = uuid::Uuid::parse_str(s)?;
    ensure!(
        id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == s,
        "Invalid UUID"
    );
    Ok(())
}
fn normalize_username(s: &str) -> Api<String> {
    let s = s.trim().to_ascii_lowercase();
    if s.is_empty()
        || s.len() > 64
        || !s.as_bytes()[0].is_ascii_alphanumeric()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(invalid(
            "Choose a username of 1–64 ASCII letters, digits, dots, underscores, or hyphens.",
        ));
    }
    Ok(s)
}
fn display_name(s: &str) -> Api<String> {
    let s = s.trim();
    if !(1..=120).contains(&s.chars().count()) || s.chars().any(char::is_control) {
        return Err(invalid(
            "Choose a display name of 1–120 characters without control characters.",
        ));
    }
    Ok(s.into())
}
fn password(s: &str) -> Api<()> {
    if s.chars().count() < 12 || s.len() > 1024 {
        return Err(invalid(
            "Passwords must contain at least 12 characters and at most 1024 UTF-8 bytes.",
        ));
    }
    Ok(())
}
fn account_role(s: &str) -> Api<()> {
    if !["user", "administrator"].contains(&s) {
        return Err(invalid("Invalid account role"));
    }
    Ok(())
}
pub fn invalid(s: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, s.into())
}
pub fn unauthorized() -> Error {
    Error(StatusCode::UNAUTHORIZED, "invalid_credentials".into())
}
pub fn forbidden() -> Error {
    Error(StatusCode::FORBIDDEN, "Insufficient permission".into())
}
pub fn unavailable() -> Error {
    Error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Service temporarily unavailable".into(),
    )
}
pub async fn hash_password(value: String) -> Result<String> {
    password(&value).map_err(|e| anyhow::anyhow!(e.1))?;
    let permit = HASH_WORKERS
        .get()
        .context("Password worker unavailable")?
        .clone()
        .acquire_owned()
        .await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::generate(&mut OsRng);
        argon()
            .hash_password(value.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|_| anyhow::anyhow!("Password hashing failed"))
    })
    .await?
}
async fn verify(value: String, hash: String) -> Result<bool> {
    let permit = HASH_WORKERS
        .get()
        .context("Password worker unavailable")?
        .clone()
        .acquire_owned()
        .await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let hash =
            PasswordHash::new(&hash).map_err(|_| anyhow::anyhow!("Invalid password hash"))?;
        Ok(argon().verify_password(value.as_bytes(), &hash).is_ok())
    })
    .await?
}
pub fn read_user(db: &Connection, field: &str, value: &str) -> Result<Option<User>> {
    ensure!(matches!(field, "id" | "username"), "Invalid user lookup");
    let user=db.query_row(&format!("SELECT id,username,display_name,role,enabled,created_at_ms,password_hash FROM users WHERE {field}=?1"),[value],|r|Ok(User{id:r.get(0)?,username:r.get(1)?,display_name:r.get(2)?,role:r.get(3)?,enabled:r.get(4)?,created_at_ms:r.get(5)?,password_hash:r.get(6)?})).optional()?;
    if let Some(u) = &user {
        valid_id(&u.id)?;
        ensure!(
            normalize_username(&u.username).is_ok_and(|s| s == u.username),
            "Invalid username"
        );
        ensure!(
            display_name(&u.display_name).is_ok_and(|s| s == u.display_name),
            "Invalid display name"
        );
        ensure!(
            PasswordHash::new(&u.password_hash).is_ok(),
            "Invalid password hash"
        );
    }
    Ok(user)
}
pub async fn current(app: &Shared, auth: &Auth) -> Api<User> {
    let snapshot = auth.user.as_ref().ok_or_else(unauthorized)?;
    let id = auth.session.id().ok_or_else(unauthorized)?;
    if LoginStore(app.db.clone())
        .load(&id)
        .await
        .map_err(|_| unavailable())?
        .is_none()
    {
        return Err(unauthorized());
    }
    let user = auth
        .backend
        .get_user(&snapshot.id)
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unauthorized)?;
    if user.password_hash != snapshot.password_hash {
        return Err(unauthorized());
    }
    Ok(user)
}
pub async fn admin(app: &Shared, auth: &Auth) -> Api<User> {
    let user = current(app, auth).await?;
    if user.role != "administrator" {
        return Err(forbidden());
    }
    Ok(user)
}
pub fn effective(db: &Connection, user: &str, machine: &str) -> Result<Option<String>> {
    let Some(u) = read_user(db, "id", user)?.filter(|u| u.enabled) else {
        return Ok(None);
    };
    if u.role == "administrator" {
        return Ok(Some("manager".into()));
    }
    Ok(db
        .query_row(
            "SELECT role FROM session_access WHERE user_id=?1 AND session_id=?2",
            params![user, machine],
            |r| r.get(0),
        )
        .optional()?)
}
pub async fn machine(app: &Shared, auth: &Auth, id: &str, manager: bool) -> Api<String> {
    if valid_id(id).is_err() {
        return Err(Error(StatusCode::NOT_FOUND, "Session not found".into()));
    }
    let u = current(app, auth).await?;
    app.session(id).await?;
    let id = id.to_owned();
    let role = app
        .db
        .run(move |db| effective(db, &u.id, &id))
        .await?
        .ok_or(Error(StatusCode::NOT_FOUND, "Session not found".into()))?;
    if manager && role != "manager" {
        return Err(forbidden());
    }
    Ok(role)
}
#[derive(Default)]
pub struct Attempts(HashMap<String, (Instant, u32)>);
impl Attempts {
    fn admit(&mut self, name: String, limit: u32) -> bool {
        self.0
            .retain(|_, (time, _)| time.elapsed() < Duration::from_secs(60));
        if self.0.len() >= 4096 && !self.0.contains_key(&name) {
            return false;
        }
        let entry = self.0.entry(name).or_insert((Instant::now(), 0));
        if entry.1 >= limit {
            return false;
        }
        entry.1 += 1;
        true
    }
}
#[derive(Clone)]
pub struct CookieWrite;
pub async fn response_policy(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if res.extensions().get::<CookieWrite>().is_none() {
        res.headers_mut().remove(header::SET_COOKIE);
    }
    res.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    res.headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    res
}
pub async fn guard(auth: Auth, State(app): State<Shared>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let method = req.method().clone();
    let headers = req.headers().clone();
    let public = matches!(path.as_str(), "/setup" | "/login");
    let result: Api<()> = async {
        if !public {
            current(&app, &auth).await?;
        }
        if !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
            let host = headers
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(forbidden)?;
            let origin = headers
                .get(header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(forbidden)?;
            let form = path.ends_with("/connect");
            // Native form navigation under no-referrer sends Origin: null.
            // Fetch metadata still attests the same-origin source; the form also requires CSRF.
            let private_navigation = form
                && origin == "null"
                && headers
                    .get("sec-fetch-site")
                    .is_some_and(|v| v == "same-origin");
            if origin != format!("https://{host}") && !private_navigation {
                return Err(forbidden());
            }
            let content = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("");
            if content
                != if form {
                    "application/x-www-form-urlencoded"
                } else {
                    "application/json"
                }
            {
                return Err(invalid("Invalid content type"));
            }
            if !public && !form {
                let expected: String = auth
                    .session
                    .get("innkeeper.csrf_token")
                    .await
                    .map_err(|_| unavailable())?
                    .ok_or_else(forbidden)?;
                let provided = headers
                    .get("x-innkeeper-csrf")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                if !bool::from(expected.as_bytes().ct_eq(provided.as_bytes())) {
                    return Err(forbidden());
                }
            }
        }
        Ok(())
    }
    .await;
    match result {
        Ok(()) => next.run(req).await,
        Err(e)
            if e.0 == StatusCode::UNAUTHORIZED
                && method == Method::GET
                && path.ends_with("/connect") =>
        {
            let destination = format!("/api{path}");
            let url =
                reqwest::Url::parse_with_params("https://localhost/", &[("return", destination)])
                    .unwrap();
            axum::response::Redirect::to(&format!("/?{}", url.query().unwrap())).into_response()
        }
        Err(e) => e.into_response(),
    }
}
async fn metadata(app: &Shared, auth: &Auth) -> Api<Value> {
    let user = current(app, auth).await?;
    let record = LoginStore(app.db.clone())
        .load(&auth.session.id().ok_or_else(unauthorized)?)
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unauthorized)?;
    Ok(
        json!({"user":user,"csrf_token":record.data["innkeeper.csrf_token"],"session_expires_at_ms":record.expiry_date.unix_timestamp_nanos()/1_000_000,"server_time_ms":now_ms()}),
    )
}
async fn establish(app: &Shared, auth: &mut Auth, user: User, status: StatusCode) -> Api<Response> {
    auth.session.flush().await.map_err(|_| unavailable())?;
    auth.login(&user).await.map_err(|_| unavailable())?;
    auth.session
        .insert("innkeeper.user_id", &user.id)
        .await
        .map_err(|_| unavailable())?;
    auth.session
        .insert("innkeeper.csrf_token", secret())
        .await
        .map_err(|_| unavailable())?;
    auth.session.set_expiry(Some(Expiry::AtDateTime(
        OffsetDateTime::now_utc() + time::Duration::days(7),
    )));
    auth.session.save().await.map_err(|_| unavailable())?;
    let mut response = (status, Json(metadata(app, auth).await?)).into_response();
    response.extensions_mut().insert(CookieWrite);
    Ok(response)
}
async fn setup_status(State(app): State<Shared>) -> Api<Json<Value>> {
    Ok(Json(
        json!({"required":app.db.run(|db|Ok(db.query_row("SELECT NOT EXISTS(SELECT 1 FROM users)",[],|r|r.get::<_,bool>(0))?)).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Setup {
    username: String,
    display_name: String,
    password: String,
}
async fn setup(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut auth: Auth,
    Json(input): Json<Setup>,
) -> Api<Response> {
    if app
        .db
        .run(|db| {
            Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM users)", [], |r| {
                r.get::<_, bool>(0)
            })?)
        })
        .await?
    {
        return Err(Error(StatusCode::CONFLICT, "setup_complete".into()));
    }
    if !app
        .login_attempts
        .lock()
        .await
        .admit(format!("setup:{}", peer.ip()), 30)
    {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Setup rate limit exceeded".into(),
        ));
    }
    let username = normalize_username(&input.username)?;
    let name = display_name(&input.display_name)?;
    password(&input.password)?;
    let hash = hash_password(input.password).await?;
    crate::finish_operation(async move {
        let _guard = app.authorization.write().await;
        let user = app
            .db
            .run(move |db| {
                let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let count: i64 = tx.query_row("SELECT count(*) FROM users", [], |r| r.get(0))?;
                if count != 0 {
                    return Ok(None);
                }
                let user = insert_user(&tx, username, name, hash, "administrator".into())?;
                tx.commit()?;
                Ok(Some(user))
            })
            .await?
            .ok_or(Error(StatusCode::CONFLICT, "setup_complete".into()))?;
        establish(&app, &mut auth, user, StatusCode::CREATED).await
    })
    .await
}
fn insert_user(
    db: &Connection,
    username: String,
    name: String,
    hash: String,
    role: String,
) -> Result<User> {
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO users VALUES(?1,?2,?3,?4,?5,1,?6)",
        params![id, username, name, hash, role, now_ms() as i64],
    )?;
    read_user(db, "id", &id)?.context("Account missing")
}
async fn login(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut auth: Auth,
    Json(input): Json<Credentials>,
) -> Api<Response> {
    if input.password.len() > 1024 {
        return Err(unauthorized());
    }
    let name = normalize_username(&input.username).unwrap_or_default();
    {
        let mut attempts = app.login_attempts.lock().await;
        if !attempts.admit(format!("ip:{}", peer.ip()), 30)
            || !attempts.admit(format!("user:{name}"), 5)
        {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Login rate limit exceeded".into(),
            ));
        }
    }
    let user = auth
        .authenticate(input)
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unauthorized)?;
    {
        let mut attempts = app.login_attempts.lock().await;
        for key in [format!("ip:{}", peer.ip()), format!("user:{name}")] {
            if let Some((_, count)) = attempts.0.get_mut(&key) {
                *count = count.saturating_sub(1);
            }
        }
    }
    crate::finish_operation(async move {
        let _guard = app.authorization.write().await;
        let fresh = auth
            .backend
            .get_user(&user.id)
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(unauthorized)?;
        if fresh.password_hash != user.password_hash {
            return Err(unauthorized());
        }
        establish(&app, &mut auth, fresh, StatusCode::OK).await
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}
async fn logout(State(app): State<Shared>, mut auth: Auth, Json(_): Json<Empty>) -> Api<Response> {
    crate::finish_operation(async move {
        let _guard = app.authorization.write().await;
        current(&app, &auth).await?;
        auth.logout().await.map_err(|_| unavailable())?;
        let mut r = StatusCode::NO_CONTENT.into_response();
        r.extensions_mut().insert(CookieWrite);
        Ok(r)
    })
    .await
}
async fn me(State(app): State<Shared>, auth: Auth) -> Api<Json<Value>> {
    let _guard = app.authorization.read().await;
    Ok(Json(metadata(&app, &auth).await?))
}
async fn renew(State(app): State<Shared>, auth: Auth, Json(_): Json<Empty>) -> Api<Response> {
    crate::finish_operation(async move {
    let _guard = app.authorization.write().await;
    current(&app, &auth).await?;
    let record = LoginStore(app.db.clone())
        .load(&auth.session.id().ok_or_else(unauthorized)?)
        .await
        .map_err(|_| unavailable())?
        .ok_or_else(unauthorized)?;
    let now = OffsetDateTime::now_utc();
    let renew = record.expiry_date - now <= time::Duration::days(2);
    let expiry = if renew {
        now + time::Duration::days(7)
    } else {
        record.expiry_date
    };
    if renew {
        auth.session.set_expiry(Some(Expiry::AtDateTime(expiry)));
        auth.session.save().await.map_err(|_| unavailable())?;
    }
    let mut res=Json(json!({"session_expires_at_ms":expiry.unix_timestamp_nanos()/1_000_000,"server_time_ms":now_ms()})).into_response();
    if renew {
        res.extensions_mut().insert(CookieWrite);
    }
    Ok(res)
    }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    display_name: String,
}
async fn profile(
    State(app): State<Shared>,
    auth: Auth,
    Json(input): Json<Profile>,
) -> Api<Json<Value>> {
    crate::finish_operation(async move {
        let name = display_name(&input.display_name)?;
        let _guard = app.authorization.write().await;
        let u = current(&app, &auth).await?;
        let u = app
            .db
            .run(move |db| {
                db.execute(
                    "UPDATE users SET display_name=?1 WHERE id=?2",
                    params![name, u.id],
                )?;
                read_user(db, "id", &u.id)?.context("User missing")
            })
            .await?;
        Ok(Json(json!({"user":u})))
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnPassword {
    current_password: String,
    password: String,
}
async fn own_password(
    State(app): State<Shared>,
    mut auth: Auth,
    Json(input): Json<OwnPassword>,
) -> Api<Response> {
    crate::finish_operation(async move {
        password(&input.password)?;
        if input.current_password.len() > 1024 {
            return Err(unauthorized());
        }
        let snapshot = current(&app, &auth).await?;
        if !verify(input.current_password, snapshot.password_hash.clone()).await? {
            return Err(unauthorized());
        }
        let hash = hash_password(input.password).await?;
        let _guard = app.authorization.write().await;
        let current = current(&app, &auth).await?;
        if current.password_hash != snapshot.password_hash {
            return Err(unauthorized());
        }
        write_password(&app.db, snapshot.id, hash).await?;
        auth.logout().await.map_err(|_| unavailable())?;
        let mut res = StatusCode::NO_CONTENT.into_response();
        res.extensions_mut().insert(CookieWrite);
        Ok(res)
    })
    .await
}
pub async fn write_password(store: &Store, id: String, hash: String) -> Result<()> {
    store
        .run(move |db| {
            let tx = db.transaction()?;
            ensure!(
                tx.execute(
                    "UPDATE users SET password_hash=?1 WHERE id=?2",
                    params![hash, id]
                )? == 1,
                "Account not found"
            );
            tx.execute("DELETE FROM login_sessions WHERE user_id=?1", [id])?;
            tx.commit()?;
            Ok(())
        })
        .await
}
async fn users(State(app): State<Shared>, auth: Auth) -> Api<Json<Value>> {
    let _guard = app.authorization.read().await;
    admin(&app, &auth).await?;
    Ok(Json(json!({"users":all_users(&app.db).await?})))
}
pub async fn all_users(store: &Store) -> Result<Vec<User>> {
    store
        .run(|db| {
            let ids = db
                .prepare("SELECT id FROM users ORDER BY username")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids.iter()
                .map(|id| read_user(db, "id", id)?.context("User missing"))
                .collect()
        })
        .await
}
fn default_role() -> String {
    "user".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewUser {
    username: String,
    display_name: String,
    password: String,
    #[serde(default = "default_role")]
    role: String,
}
async fn add_user(
    State(app): State<Shared>,
    auth: Auth,
    Json(input): Json<NewUser>,
) -> Api<Response> {
    crate::finish_operation(async move {
        admin(&app, &auth).await?;
        let name = normalize_username(&input.username)?;
        let display = display_name(&input.display_name)?;
        account_role(&input.role)?;
        password(&input.password)?;
        let hash = hash_password(input.password).await?;
        let _guard = app.authorization.write().await;
        admin(&app, &auth).await?;
        let u = app
            .db
            .run(move |db| insert_user(db, name, display, hash, input.role))
            .await
            .map_err(account_error)?;
        Ok((StatusCode::CREATED, Json(json!({"user":u}))).into_response())
    })
    .await
}
fn account_error(e: anyhow::Error) -> Error {
    if e.downcast_ref::<rusqlite::Error>().is_some_and(|e|matches!(e,rusqlite::Error::SqliteFailure(code,_) if code.code==rusqlite::ErrorCode::ConstraintViolation)){Error(StatusCode::CONFLICT,"Username already exists".into())}else{unavailable()}
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct EditUser {
    username: Option<String>,
    display_name: Option<String>,
    role: Option<String>,
    enabled: Option<bool>,
}
async fn edit_user(
    State(app): State<Shared>,
    auth: Auth,
    Path(id): Path<String>,
    Json(mut input): Json<EditUser>,
) -> Api<Json<Value>> {
    crate::finish_operation(async move {
        if input.username.is_none()
            && input.display_name.is_none()
            && input.role.is_none()
            && input.enabled.is_none()
        {
            return Err(invalid("No account fields supplied"));
        }
        input.username = input.username.map(|v| normalize_username(&v)).transpose()?;
        input.display_name = input.display_name.map(|v| display_name(&v)).transpose()?;
        if let Some(role) = &input.role {
            account_role(role)?
        }
        let _guard = app.authorization.write().await;
        admin(&app, &auth).await?;
        let result = app
            .db
            .run(move |db| {
                let tx = db.transaction()?;
                let Some(mut u) = read_user(&tx, "id", &id)? else {
                    return Ok(None);
                };
                if let Some(v) = input.username {
                    u.username = v
                }
                if let Some(v) = input.display_name {
                    u.display_name = v
                }
                if let Some(v) = input.role {
                    u.role = v
                }
                if let Some(v) = input.enabled {
                    u.enabled = v
                }
                if !(u.enabled && u.role == "administrator") && last_admin(&tx, &id)? {
                    return Ok(Some(Err(())));
                }
                tx.execute(
                    "UPDATE users SET username=?1,display_name=?2,role=?3,enabled=?4 WHERE id=?5",
                    params![u.username, u.display_name, u.role, u.enabled, id],
                )?;
                if !u.enabled {
                    tx.execute("DELETE FROM login_sessions WHERE user_id=?1", [&id])?;
                }
                crate::tokens::mark_invalid(&tx)?;
                tx.commit()?;
                Ok(Some(Ok(u)))
            })
            .await
            .map_err(account_error)?
            .ok_or(Error(StatusCode::NOT_FOUND, "User not found".into()))?
            .map_err(|_| {
                Error(
                    StatusCode::CONFLICT,
                    "Cannot remove the last enabled Administrator".into(),
                )
            })?;
        app.token_wake.notify_one();
        Ok(Json(json!({"user":result})))
    })
    .await
}
fn last_admin(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND role='administrator' AND enabled=1) AND NOT EXISTS(SELECT 1 FROM users WHERE id<>?1 AND role='administrator' AND enabled=1)",[id],|r|r.get(0))?)
}
async fn delete_user(
    State(app): State<Shared>,
    auth: Auth,
    Path(id): Path<String>,
) -> Api<StatusCode> {
    crate::finish_operation(async move {
        let _guard = app.authorization.write().await;
        admin(&app, &auth).await?;
        let result = app
            .db
            .run(move |db| {
                let tx = db.transaction()?;
                if read_user(&tx, "id", &id)?.is_none() {
                    return Ok(0);
                }
                if last_admin(&tx, &id)? {
                    return Ok(2);
                }
                tx.execute(
                    "UPDATE instance_tokens SET revoked=1 WHERE user_id=?1",
                    [&id],
                )?;
                tx.execute("DELETE FROM users WHERE id=?1", [id])?;
                tx.commit()?;
                Ok(1)
            })
            .await?;
        match result {
            0 => Err(Error(StatusCode::NOT_FOUND, "User not found".into())),
            2 => Err(Error(
                StatusCode::CONFLICT,
                "Cannot remove the last enabled Administrator".into(),
            )),
            _ => {
                app.token_wake.notify_one();
                Ok(StatusCode::NO_CONTENT)
            }
        }
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Password {
    password: String,
}
async fn reset_password(
    State(app): State<Shared>,
    auth: Auth,
    Path(id): Path<String>,
    Json(input): Json<Password>,
) -> Api<StatusCode> {
    crate::finish_operation(async move {
        admin(&app, &auth).await?;
        password(&input.password)?;
        let hash = hash_password(input.password).await?;
        let _guard = app.authorization.write().await;
        admin(&app, &auth).await?;
        let target = id.clone();
        if app
            .db
            .run(move |db| read_user(db, "id", &target))
            .await?
            .is_none()
        {
            return Err(Error(StatusCode::NOT_FOUND, "User not found".into()));
        }
        write_password(&app.db, id, hash).await?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}
async fn access(State(app): State<Shared>, auth: Auth, Path(id): Path<String>) -> Api<Json<Value>> {
    let _guard = app.authorization.read().await;
    admin(&app, &auth).await?;
    app.session(&id).await?;
    let rows=app.db.run(move|db|{Ok(db.prepare("SELECT a.user_id,u.display_name,a.role FROM session_access a JOIN users u ON u.id=a.user_id WHERE session_id=?1 ORDER BY u.display_name,u.id")?.query_map([id],|r|Ok(json!({"user_id":r.get::<_,String>(0)?,"display_name":r.get::<_,String>(1)?,"role":r.get::<_,String>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?)}).await?;
    Ok(Json(json!({"assignments":rows})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    role: String,
}
async fn put_access(
    State(app): State<Shared>,
    auth: Auth,
    Path((id, user)): Path<(String, String)>,
    Json(input): Json<Grant>,
) -> Api<Json<Value>> {
    if !["viewer", "interactive", "manager"].contains(&input.role.as_str()) {
        return Err(invalid("Invalid machine role"));
    }
    change_access(&app, &auth, id, user.clone(), Some(input.role.clone())).await?;
    Ok(Json(json!({"user_id":user,"role":input.role})))
}
async fn delete_access(
    State(app): State<Shared>,
    auth: Auth,
    Path((id, user)): Path<(String, String)>,
) -> Api<StatusCode> {
    change_access(&app, &auth, id, user, None).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn change_access(
    app: &Shared,
    auth: &Auth,
    id: String,
    user: String,
    role: Option<String>,
) -> Api<()> {
    let app = app.clone();
    let auth = auth.clone();
    crate::finish_operation(async move {
    let _guard = app.authorization.write().await;
    admin(&app, &auth).await?;
    app.session(&id).await?;
    let exists=app.db.run(move|db|{let tx=db.transaction()?;if read_user(&tx,"id",&user)?.is_none(){return Ok(false)}if let Some(role)=role{tx.execute("INSERT INTO session_access VALUES(?1,?2,?3) ON CONFLICT(session_id,user_id) DO UPDATE SET role=excluded.role",params![id,user,role])?;}else{tx.execute("DELETE FROM session_access WHERE session_id=?1 AND user_id=?2",params![id,user])?;}crate::tokens::mark_invalid(&tx)?;tx.commit()?;Ok(true)}).await?;
    if !exists {
        return Err(Error(StatusCode::NOT_FOUND, "User not found".into()));
    }
    app.token_wake.notify_one();
    Ok(())
    }).await
}
pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/setup", get(setup_status).post(setup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me).patch(profile))
        .route("/me/password", put(own_password))
        .route("/session/renew", post(renew))
        .route("/users", get(users).post(add_user))
        .route(
            "/users/{id}",
            axum::routing::patch(edit_user).delete(delete_user),
        )
        .route("/users/{id}/password", put(reset_password))
        .route("/sessions/{id}/access", get(access))
        .route(
            "/sessions/{id}/access/{user_id}",
            put(put_access).delete(delete_access),
        )
}
