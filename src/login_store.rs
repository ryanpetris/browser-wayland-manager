use crate::store::Store;
use anyhow::{Context, Result, ensure};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tower_sessions::{
    ExpiredDeletion, SessionStore,
    session::{Id, Record},
    session_store,
};

#[derive(Clone, Debug)]
pub struct LoginStore(pub Store);
fn key(id: Id) -> Vec<u8> {
    Sha256::digest(id.to_string().as_bytes()).to_vec()
}
fn failure(_: anyhow::Error) -> session_store::Error {
    session_store::Error::Backend("Login session storage failed".into())
}
fn identity(record: &Record) -> Result<String> {
    let id = record
        .data
        .get("innkeeper.user_id")
        .and_then(|v| v.as_str())
        .context("Missing session identity")?;
    crate::accounts::valid_id(id)?;
    ensure!(
        record
            .data
            .get("innkeeper.auth")
            .and_then(|v| v.get("user_id"))
            .and_then(|v| v.as_str())
            == Some(id),
        "Session identity mismatch"
    );
    ensure!(
        record
            .data
            .get("innkeeper.csrf_token")
            .and_then(|v| v.as_str())
            .is_some_and(crate::accounts::valid_secret),
        "Invalid CSRF token"
    );
    Ok(id.into())
}
fn validate_account(db: &rusqlite::Connection, record: &Record, user: &str) -> Result<()> {
    let hash: Option<String> = db
        .query_row(
            "SELECT password_hash FROM users WHERE id=?1 AND enabled=1",
            [user],
            |r| r.get(0),
        )
        .optional()?;
    let stored: Vec<u8> =
        serde_json::from_value(record.data["innkeeper.auth"]["auth_hash"].clone())?;
    ensure!(
        hash.is_some_and(|h| h.as_bytes() == stored),
        "Session account invalidated"
    );
    Ok(())
}
#[async_trait::async_trait]
impl SessionStore for LoginStore {
    async fn create(&self, record: &mut Record) -> session_store::Result<()> {
        let mut r = record.clone();
        let user = identity(&r).map_err(failure)?;
        let id = self
            .0
            .run(move |db| {
                let tx = db.transaction()?;
                validate_account(&tx, &r, &user)?;
                ensure!(r.expiry_date > OffsetDateTime::now_utc(), "Expired session");
                loop {
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM login_sessions WHERE secret_hash=?1)",
                        [key(r.id)],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        break;
                    }
                    r.id = Id::default();
                }
                tx.execute(
                    "INSERT INTO login_sessions VALUES(?1,?2,?3,?4,?5)",
                    params![
                        key(r.id),
                        user,
                        serde_json::to_string(&r.data)?,
                        r.expiry_date.unix_timestamp(),
                        r.expiry_date.nanosecond()
                    ],
                )?;
                tx.commit()?;
                Ok(r.id)
            })
            .await
            .map_err(failure)?;
        record.id = id;
        Ok(())
    }
    async fn save(&self, record: &Record) -> session_store::Result<()> {
        let r = record.clone();
        let user = identity(&r).map_err(failure)?;
        self.0.run(move |db| {
            let tx=db.transaction()?; validate_account(&tx,&r,&user)?;
            let now=OffsetDateTime::now_utc();
            // A stale middleware save may update data but never shorten a renewed deadline.
            let changed=tx.execute("UPDATE login_sessions SET data=?1,
                expires_at_unix_seconds=CASE WHEN (expires_at_unix_seconds,expires_at_nanosecond)<(?2,?3) THEN ?2 ELSE expires_at_unix_seconds END,
                expires_at_nanosecond=CASE WHEN (expires_at_unix_seconds,expires_at_nanosecond)<(?2,?3) THEN ?3 ELSE expires_at_nanosecond END
                WHERE secret_hash=?4 AND user_id=?5 AND (expires_at_unix_seconds,expires_at_nanosecond)>(?6,?7)",params![serde_json::to_string(&r.data)?,r.expiry_date.unix_timestamp(),r.expiry_date.nanosecond(),key(r.id),user,now.unix_timestamp(),now.nanosecond()])?;
            ensure!(changed==1,"Login session invalidated"); tx.commit()?; Ok(())
        }).await.map_err(failure)
    }
    async fn load(&self, id: &Id) -> session_store::Result<Option<Record>> {
        let id = *id;
        self.0.run(move |db| {
            let row:Option<(String,String,i64,u32)>=db.query_row("SELECT user_id,data,expires_at_unix_seconds,expires_at_nanosecond FROM login_sessions WHERE secret_hash=?1",[key(id)],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            let Some((user,data,sec,nanos))=row else {return Ok(None)};
            let expiry_date=OffsetDateTime::from_unix_timestamp(sec)?.replace_nanosecond(nanos)?;
            if expiry_date<=OffsetDateTime::now_utc(){return Ok(None)}
            let r=Record{id,data:serde_json::from_str(&data)?,expiry_date};
            ensure!(identity(&r)?==user,"Session index mismatch"); Ok(Some(r))
        }).await.map_err(failure)
    }
    async fn delete(&self, id: &Id) -> session_store::Result<()> {
        let key = key(*id);
        self.0
            .run(move |db| {
                db.execute("DELETE FROM login_sessions WHERE secret_hash=?1", [key])?;
                Ok(())
            })
            .await
            .map_err(failure)
    }
}
#[async_trait::async_trait]
impl ExpiredDeletion for LoginStore {
    async fn delete_expired(&self) -> session_store::Result<()> {
        self.0.run(|db|{let now=OffsetDateTime::now_utc();db.execute("DELETE FROM login_sessions WHERE (expires_at_unix_seconds,expires_at_nanosecond)<=(?1,?2)",params![now.unix_timestamp(),now.nanosecond()])?;Ok(())}).await.map_err(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn persistence_collision_renewal_and_invalidation() {
        crate::accounts::initialize().await.unwrap();
        let path = std::env::temp_dir().join(format!("login-{}.sqlite3", uuid::Uuid::new_v4()));
        let db = Store::open(path.clone()).await.unwrap();
        let user = uuid::Uuid::new_v4().to_string();
        let hash = crate::accounts::hash_password("a sufficiently long password".into())
            .await
            .unwrap();
        let uid = user.clone();
        let h = hash.clone();
        db.run(move |db| {
            db.execute(
                "INSERT INTO users VALUES(?1,'first','First',?2,'administrator',1,0)",
                params![uid, h],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let store = LoginStore(db.clone());
        let mut r = Record {
            id: Id::default(),
            data: [
                ("innkeeper.user_id".into(), json!(user)),
                (
                    "innkeeper.auth".into(),
                    json!({"user_id":user,"auth_hash":hash.as_bytes()}),
                ),
                (
                    "innkeeper.csrf_token".into(),
                    json!(crate::accounts::secret()),
                ),
            ]
            .into(),
            expiry_date: OffsetDateTime::now_utc() + time::Duration::days(7),
        };
        SessionStore::create(&store, &mut r).await.unwrap();
        let persisted = store.load(&r.id).await.unwrap().unwrap();
        assert_eq!(persisted.expiry_date, r.expiry_date);
        assert_eq!(persisted.data, r.data);
        let mut collision = r.clone();
        SessionStore::create(&store, &mut collision).await.unwrap();
        assert_ne!(collision.id, r.id);
        let mut renewed = r.clone();
        renewed.expiry_date += time::Duration::days(1);
        store.save(&renewed).await.unwrap();
        store.save(&r).await.unwrap();
        assert_eq!(
            store.load(&r.id).await.unwrap().unwrap().expiry_date,
            renewed.expiry_date
        );
        let reopened = LoginStore(Store::open(path.clone()).await.unwrap());
        assert!(reopened.load(&r.id).await.unwrap().is_some());
        store.delete(&r.id).await.unwrap();
        store.delete(&r.id).await.unwrap();
        assert!(store.save(&r).await.is_err());
        assert!(store.load(&r.id).await.unwrap().is_none());
        let uid = user.clone();
        db.run(move |db| {
            db.execute("UPDATE users SET enabled=0 WHERE id=?1", [uid])?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(store.save(&collision).await.is_err());
        let mut mismatch = collision.clone();
        mismatch.data.insert(
            "innkeeper.user_id".into(),
            json!(uuid::Uuid::new_v4().to_string()),
        );
        assert!(SessionStore::create(&store, &mut mismatch).await.is_err());
        let key = key(collision.id);
        db.run(move|db|{db.execute("UPDATE login_sessions SET expires_at_unix_seconds=0,expires_at_nanosecond=0 WHERE secret_hash=?1",[key])?;Ok(())}).await.unwrap();
        assert!(store.load(&collision.id).await.unwrap().is_none());
        store.delete_expired().await.unwrap();
        drop(reopened);
        drop(store);
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
