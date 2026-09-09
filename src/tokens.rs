use crate::{
    Api, Error, Session, Shared,
    accounts::{self, Auth},
    now_ms,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Form,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

const VIEWER: &[&str] = &["audio.listen", "clipboard.read", "desktop.view"];
const INTERACTIVE: &[&str] = &[
    "apps.launch",
    "audio.listen",
    "broadcasts.manage",
    "camera.send",
    "clipboard.read",
    "clipboard.write",
    "commands.execute",
    "desktop.control",
    "desktop.view",
    "dragdrop.upload",
    "files.browse",
    "files.download",
    "files.manage",
    "files.upload",
    "microphone.send",
];
pub fn grants(role: &str) -> BTreeSet<String> {
    if role == "viewer" {
        VIEWER
    } else {
        INTERACTIVE
    }
    .iter()
    .map(|s| (*s).into())
    .collect()
}
fn all_grants() -> BTreeSet<String> {
    let mut p = grants("manager");
    p.extend(["tokens.manage".into(), "server.manage".into()]);
    p
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Metadata {
    pub id: String,
    pub label: String,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
    pub permissions: BTreeSet<String>,
}
impl Metadata {
    fn validate(&self) -> Result<()> {
        accounts::valid_id(&self.id)?;
        ensure!(
            self.permissions.is_subset(&all_grants()),
            "Unknown Elsewhere permission"
        );
        ensure!(
            self.created_at_ms >= 0
                && !self.label.trim().is_empty()
                && self.label.chars().count() <= 120
                && !self.label.chars().any(char::is_control),
            "Invalid Elsewhere metadata"
        );
        Ok(())
    }
}
#[derive(Deserialize)]
struct Me {
    metadata: Metadata,
    permissions: BTreeSet<String>,
    available_permissions: BTreeSet<String>,
}
#[derive(Deserialize)]
struct Created {
    token: String,
    metadata: Metadata,
}
#[derive(Deserialize)]
struct Inventory {
    tokens: Vec<Metadata>,
}
#[derive(Clone)]
pub struct Token {
    pub id: String,
    pub user: Option<String>,
    pub kind: String,
    pub secret: Option<String>,
    pub revoked: bool,
    pub permissions: BTreeSet<String>,
}
fn read_tokens(db: &Connection, machine: &str) -> Result<Vec<Token>> {
    let rows = db
        .prepare(
            "SELECT token_id,user_id,kind,secret,revoked FROM instance_tokens WHERE session_id=?1",
        )?
        .query_map([machine], |r| {
            Ok(Token {
                id: r.get(0)?,
                user: r.get(1)?,
                kind: r.get(2)?,
                secret: r.get(3)?,
                revoked: r.get(4)?,
                permissions: BTreeSet::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|mut t|{accounts::valid_id(&t.id)?;t.permissions=db.prepare("SELECT permission FROM instance_token_permissions WHERE session_id=?1 AND token_id=?2")?.query_map(params![machine,t.id],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;Ok(t)}).collect()
}
pub async fn recorded(app: &crate::App, machine: &str) -> Result<Vec<Token>> {
    let id = machine.to_owned();
    app.db.run(move |db| read_tokens(db, &id)).await
}
pub fn mark_invalid(db: &Connection) -> Result<()> {
    let ids = db
        .prepare("SELECT DISTINCT session_id FROM instance_tokens WHERE kind='user' AND revoked=0")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        for token in read_tokens(db, &id)?
            .into_iter()
            .filter(|t| t.kind == "user" && !t.revoked)
        {
            let desired = match &token.user {
                Some(user) => accounts::effective(db, user, &id)?.map(|role| grants(&role)),
                None => None,
            };
            if desired.as_ref() != Some(&token.permissions) {
                db.execute(
                    "UPDATE instance_tokens SET revoked=1 WHERE session_id=?1 AND token_id=?2",
                    params![id, token.id],
                )?;
            }
        }
    }
    Ok(())
}
async fn retire(app: &crate::App, machine: &str, id: &str) -> Result<()> {
    let machine = machine.to_owned();
    let id = id.to_owned();
    app.db
        .run(move |db| {
            db.execute(
                "UPDATE instance_tokens SET revoked=1 WHERE session_id=?1 AND token_id=?2",
                params![machine, id],
            )?;
            Ok(())
        })
        .await
}
async fn forget(app: &crate::App, machine: &str, id: &str) -> Result<()> {
    let machine = machine.to_owned();
    let id = id.to_owned();
    app.db
        .run(move |db| {
            db.execute(
                "DELETE FROM instance_tokens WHERE session_id=?1 AND token_id=?2 AND revoked=1",
                params![machine, id],
            )?;
            Ok(())
        })
        .await
}
async fn record(
    app: &crate::App,
    machine: &str,
    meta: Metadata,
    secret: Option<String>,
    user: Option<String>,
    internal: bool,
    revoked: bool,
) -> Result<()> {
    meta.validate()?;
    ensure!(
        secret.as_deref().is_none_or(accounts::valid_secret),
        "Invalid token secret"
    );
    let machine = machine.to_owned();
    app.db
        .run(move |db| {
            let tx = db.transaction()?;
            let user = match user {
                Some(id) if accounts::read_user(&tx, "id", &id)?.is_some() => Some(id),
                _ => None,
            };
            tx.execute(
                "INSERT INTO instance_tokens VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    machine,
                    meta.id,
                    if internal { "internal" } else { "user" },
                    user,
                    secret,
                    revoked
                ],
            )?;
            for permission in meta.permissions {
                tx.execute(
                    "INSERT INTO instance_token_permissions VALUES(?1,?2,?3)",
                    params![machine, meta.id, permission],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
}
#[derive(Default)]
pub struct Retry {
    failures: u32,
    deadline: Option<Instant>,
}
impl Retry {
    fn ready(&self) -> bool {
        self.deadline.is_none_or(|d| d <= Instant::now())
    }
    fn fail(&mut self) {
        let seconds = (5u64.saturating_mul(1u64 << self.failures.min(6))).min(300);
        self.failures = self.failures.saturating_add(1);
        self.deadline = Some(Instant::now() + Duration::from_secs(seconds));
    }
}
#[derive(Default)]
pub struct Work {
    machine: Retry,
    deletions: HashMap<String, Retry>,
    next_sync: Option<Instant>,
}
#[derive(Default)]
pub struct Retries(pub HashMap<String, Work>);
async fn ready(app: &crate::App, id: &str) -> bool {
    app.token_retries
        .lock()
        .await
        .0
        .get(id)
        .is_none_or(|w| w.machine.ready())
}
async fn failed(app: &crate::App, id: &str) {
    app.token_retries
        .lock()
        .await
        .0
        .entry(id.into())
        .or_default()
        .machine
        .fail();
}
async fn me(app: &crate::App, url: &str, secret: &str) -> Result<Option<Me>> {
    let response = app
        .client
        .get(format!("{url}/api/me"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Elsewhere unavailable"))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    ensure!(
        response.status().is_success(),
        "Elsewhere authentication unavailable"
    );
    let me: Me = response
        .json()
        .await
        .context("Invalid Elsewhere identity response")?;
    me.metadata.validate()?;
    ensure!(
        me.permissions == me.metadata.permissions
            && all_grants().is_subset(&me.available_permissions),
        "Unsupported Elsewhere grants"
    );
    Ok(Some(me))
}
// Caller holds the machine operation lock. No CLI output enters a log or response.
pub async fn internal(app: &crate::App, s: &Session) -> Result<String> {
    ensure!(ready(app, &s.id).await, "Elsewhere retry pending");
    let result: Result<String> = async {
        let url = app.endpoint(s).await?;
        if let Some(t) = recorded(app, &s.id)
            .await?
            .into_iter()
            .find(|t| t.kind == "internal" && !t.revoked)
        {
            if let Some(secret) = t.secret.filter(|s| accounts::valid_secret(s)) {
                if let Some(me) = me(app, &url, &secret).await? {
                    if me.metadata.id == t.id
                        && me.permissions == all_grants()
                        && me.metadata.expires_at_ms.is_none()
                    {
                        return Ok(secret);
                    }
                }
            }
            retire(app, &s.id, &t.id).await?;
        }
        // The HTTP listener starts after Elsewhere initializes its database.
        // Wait for it before the CLI opens that database on a fresh machine.
        let probe = app
            .client
            .get(format!("{url}/api/me"))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Waiting for Elsewhere initialization"))?;
        ensure!(
            probe.status() == StatusCode::UNAUTHORIZED,
            "Waiting for Elsewhere initialization"
        );
        app.owned(&s.id).await?;
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new("docker")
                .args([
                    "exec",
                    "--user",
                    "elsewhere",
                    "--env",
                    "HOME=/home/elsewhere",
                    "--env",
                    "XDG_CONFIG_HOME=/home/elsewhere/.config",
                    &crate::container(&s.id),
                    "elsewhere",
                    "token",
                    "create",
                    "--admin",
                ])
                .kill_on_drop(true)
                .output(),
        )
        .await
        .context("Token bootstrap timed out")?
        .context("Token bootstrap unavailable")?;
        ensure!(output.status.success(), "Token bootstrap failed");
        let secret = String::from_utf8(output.stdout)
            .context("Invalid bootstrap output")?
            .trim_end_matches('\n')
            .to_owned();
        ensure!(accounts::valid_secret(&secret), "Invalid bootstrap secret");
        let me = me(app, &url, &secret)
            .await?
            .context("Bootstrap authentication unavailable")?;
        ensure!(
            me.permissions == all_grants() && me.metadata.expires_at_ms.is_none(),
            "Invalid internal grants"
        );
        record(
            app,
            &s.id,
            me.metadata,
            Some(secret.clone()),
            None,
            true,
            false,
        )
        .await?;
        inventory(app, s, &url, &secret).await?;
        Ok(secret)
    }
    .await;
    if result.is_err() {
        failed(app, &s.id).await;
    }
    result
}
async fn inventory(
    app: &crate::App,
    s: &Session,
    url: &str,
    secret: &str,
) -> Result<Vec<Metadata>> {
    let response = app
        .client
        .get(format!("{url}/api/tokens"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Token inventory unavailable"))?;
    ensure!(
        response.status() == StatusCode::OK,
        "Token inventory unavailable"
    );
    let remote: Inventory = response.json().await.context("Invalid token inventory")?;
    let local = recorded(app, &s.id).await?;
    let known: BTreeSet<_> = local.iter().map(|t| t.id.clone()).collect();
    for meta in &remote.tokens {
        meta.validate()?;
        if !known.contains(&meta.id) {
            let user = meta
                .label
                .strip_prefix("Innkeeper user ")
                .filter(|id| accounts::valid_id(id).is_ok());
            if user.is_some() || meta.label == "Admin" {
                record(
                    app,
                    &s.id,
                    meta.clone(),
                    None,
                    user.map(str::to_owned),
                    user.is_none(),
                    true,
                )
                .await?;
            }
        }
    }
    for t in local {
        if t.kind == "user" && !t.revoked {
            let desired = if let Some(user) = t.user {
                let id = s.id.clone();
                app.db
                    .run(move |db| {
                        Ok(accounts::effective(db, &user, &id)?.map(|role| grants(&role)))
                    })
                    .await?
            } else {
                None
            };
            let valid = remote
                .tokens
                .iter()
                .find(|m| m.id == t.id)
                .is_some_and(|m| {
                    desired.as_ref() == Some(&m.permissions)
                        && m.permissions == t.permissions
                        && m.expires_at_ms
                            .is_none_or(|expiry| expiry > now_ms() as i64)
                });
            if !valid {
                retire(app, &s.id, &t.id).await?;
            }
        }
    }
    app.token_retries
        .lock()
        .await
        .0
        .entry(s.id.clone())
        .or_default()
        .machine = Retry::default();
    Ok(remote.tokens)
}
async fn remove_retired(
    app: &crate::App,
    s: &Session,
    url: &str,
    secret: &str,
    remote: &[Metadata],
) -> Result<()> {
    for t in recorded(app, &s.id)
        .await?
        .into_iter()
        .filter(|t| t.revoked)
    {
        if !remote.iter().any(|m| m.id == t.id) {
            forget(app, &s.id, &t.id).await?;
            app.token_retries
                .lock()
                .await
                .0
                .entry(s.id.clone())
                .or_default()
                .deletions
                .remove(&t.id);
            continue;
        }
        let due = app
            .token_retries
            .lock()
            .await
            .0
            .entry(s.id.clone())
            .or_default()
            .deletions
            .entry(t.id.clone())
            .or_default()
            .ready();
        if !due {
            continue;
        }
        let result = app
            .client
            .delete(format!("{url}/api/tokens/{}", t.id))
            .bearer_auth(secret)
            .send()
            .await;
        if result
            .is_ok_and(|r| matches!(r.status(), StatusCode::NO_CONTENT | StatusCode::NOT_FOUND))
        {
            forget(app, &s.id, &t.id).await?;
            app.token_retries
                .lock()
                .await
                .0
                .entry(s.id.clone())
                .or_default()
                .deletions
                .remove(&t.id);
        } else {
            app.token_retries
                .lock()
                .await
                .0
                .entry(s.id.clone())
                .or_default()
                .deletions
                .entry(t.id)
                .or_default()
                .fail();
        }
    }
    Ok(())
}
// Each launch gets fresh readiness scheduling; deletion deadlines stay independent.
pub async fn launching(app: &crate::App, id: &str) {
    app.token_retries
        .lock()
        .await
        .0
        .entry(id.into())
        .or_default()
        .machine = Retry::default();
}
pub async fn readiness(app: &crate::App, s: &Session) -> Result<()> {
    // Listener startup is polled by reconciliation, not token-failure backoff.
    let url = app.endpoint(s).await?;
    let response = app.client.get(format!("{url}/api/me")).send().await?;
    ensure!(
        response.status() == StatusCode::UNAUTHORIZED,
        "Waiting for Elsewhere initialization"
    );
    sync(app, s).await
}
pub async fn sync(app: &crate::App, s: &Session) -> Result<()> {
    ensure!(ready(app, &s.id).await, "Elsewhere retry pending");
    let result: Result<()> = async {
        let secret = internal(app, s).await?;
        let url = app.endpoint(s).await?;
        let remote = inventory(app, s, &url, &secret).await?;
        remove_retired(app, s, &url, &secret, &remote).await?;
        Ok(())
    }
    .await;
    if result.is_err() && ready(app, &s.id).await {
        failed(app, &s.id).await;
    }
    app.token_retries
        .lock()
        .await
        .0
        .entry(s.id.clone())
        .or_default()
        .next_sync = Some(Instant::now() + Duration::from_secs(60));
    result
}
pub async fn run(app: Shared) {
    use tower_sessions::ExpiredDeletion;
    loop {
        if let Ok(sessions) = app.db.list().await {
            let mut state = app.token_retries.lock().await;
            state.0.retain(|id, _| sessions.iter().any(|s| s.id == *id));
            drop(state);
            for s in sessions.into_iter().filter(|s| s.status == "running") {
                let due = {
                    let mut state = app.token_retries.lock().await;
                    let w = state.0.entry(s.id.clone()).or_default();
                    w.machine.ready()
                        && (w.next_sync.is_none_or(|d| d <= Instant::now())
                            || w.machine.deadline.is_some()
                            || w.deletions.values().any(Retry::ready))
                };
                if !due {
                    continue;
                }
                let _auth = app.authorization.read().await;
                let lock = app.lock(&s.id).await;
                let Ok(_guard) = lock.try_lock() else {
                    continue;
                };
                let _ = sync(&app, &s).await;
            }
        }
        let _ = crate::login_store::LoginStore(app.db.clone())
            .delete_expired()
            .await;
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(1))=>{},_=app.token_wake.notified()=>{for work in app.token_retries.lock().await.0.values_mut(){work.next_sync=None;}}}
    }
}
pub async fn connect_page(
    State(app): State<Shared>,
    auth: Auth,
    Path(id): Path<String>,
) -> Api<Response> {
    let _guard = app.authorization.read().await;
    accounts::machine(&app, &auth, &id, false).await?;
    if app.session(&id).await?.status != "running" {
        return Err(Error(StatusCode::CONFLICT, "Session is not ready".into()));
    }
    let csrf: String = auth
        .session
        .get("innkeeper.csrf_token")
        .await
        .map_err(|_| accounts::unavailable())?
        .ok_or_else(accounts::forbidden)?;
    if !accounts::valid_secret(&csrf) {
        return Err(accounts::forbidden());
    }
    Ok(Html(format!("<!doctype html><meta name=referrer content=no-referrer><title>Open desktop</title><form method=post action='/api/sessions/{id}/connect'><input type=hidden name=csrf_token value='{csrf}'><button>Continue</button></form><script>document.forms[0].submit()</script>")).into_response())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connect {
    csrf_token: String,
}
pub async fn connect(
    State(app): State<Shared>,
    auth: Auth,
    Path(id): Path<String>,
    Form(input): Form<Connect>,
) -> Api<Response> {
    let expected: String = auth
        .session
        .get("innkeeper.csrf_token")
        .await
        .map_err(|_| accounts::unavailable())?
        .ok_or_else(accounts::forbidden)?;
    if !bool::from(expected.as_bytes().ct_eq(input.csrf_token.as_bytes())) {
        return Err(accounts::forbidden());
    }
    crate::finish_operation(async move{
        let _auth=app.authorization.read().await;accounts::machine(&app,&auth,&id,false).await?;drop(_auth);
        let (_auth,_guard)=app.operation(&id).await;
        let role=accounts::machine(&app,&auth,&id,false).await?;let user=accounts::current(&app,&auth).await?;let s=app.session(&id).await?;if s.status!="running"{return Err(Error(StatusCode::CONFLICT,"Session is not ready".into()))}
        let result:Result<String>=async{
            ensure!(ready(&app,&id).await,"Elsewhere retry pending");let secret=internal(&app,&s).await?;let url=app.endpoint(&s).await?;let remote=inventory(&app,&s,&url,&secret).await?;
            let desired=grants(&role);let mut reusable=None;
            for t in recorded(&app,&id).await?.into_iter().filter(|t|t.kind=="user"&&!t.revoked&&t.user.as_deref()==Some(&user.id)){
                if let Some(token)=t.secret.filter(|s|accounts::valid_secret(s)){
                    if let Some(me)=me(&app,&url,&token).await?{if me.metadata.id==t.id&&me.permissions==desired {reusable=Some(token);break}}
                }retire(&app,&id,&t.id).await?;
            }
            remove_retired(&app,&s,&url,&secret,&remote).await?;
            if let Some(token)=reusable{return Ok(token)}
            let response=app.client.post(format!("{url}/api/tokens")).bearer_auth(&secret).json(&serde_json::json!({"label":format!("Innkeeper user {}",user.id),"permissions":desired,"expires_at_ms":null})).send().await.map_err(|_|anyhow::anyhow!("Token creation unavailable"))?;
            ensure!(response.status()==StatusCode::CREATED,"Token creation unavailable");let created:Created=response.json().await.context("Invalid token creation response")?;
            ensure!(created.metadata.permissions==desired&&created.metadata.expires_at_ms.is_none()&&accounts::valid_secret(&created.token),"Invalid issued token");
            record(&app,&id,created.metadata,Some(created.token.clone()),Some(user.id),false,false).await?;Ok(created.token)
        }.await;
        match result{Ok(token)=>Ok(Redirect::to(&format!("/e/{id}/#token={token}")).into_response()),Err(_)=>{if ready(&app,&id).await{failed(&app,&id).await;}let mut res=accounts::unavailable().into_response();res.headers_mut().insert(header::RETRY_AFTER,"5".parse().unwrap());Ok(res)}}
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_delays_are_bounded_and_do_not_reset_on_observation() {
        let mut retry = Retry::default();
        assert!(retry.ready());
        for seconds in [5, 10, 20, 40, 80, 160, 300, 300] {
            let before = Instant::now();
            retry.fail();
            let deadline = retry.deadline.unwrap();
            assert!(deadline.duration_since(before) >= Duration::from_secs(seconds));
            assert!(deadline.duration_since(before) < Duration::from_secs(seconds + 1));
            for _ in 0..10 {
                assert!(!retry.ready());
                assert_eq!(retry.deadline, Some(deadline));
            }
            retry.deadline = Some(Instant::now() - Duration::from_secs(1));
            assert!(retry.ready());
        }
        assert_eq!(grants("manager"), grants("interactive"));
        assert!(grants("viewer").is_subset(&grants("interactive")));
        for role in ["viewer", "interactive", "manager"] {
            assert!(!grants(role).contains("tokens.manage"));
            assert!(!grants(role).contains("server.manage"));
        }
    }
}
