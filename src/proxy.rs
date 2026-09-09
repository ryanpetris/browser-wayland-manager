use crate::{Api, Error, Shared, env};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::Body,
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Version, header},
    response::{IntoResponse, Response},
};
use hyper_util::rt::TokioIo;
use std::{collections::HashMap, time::Duration};
use tokio::net::TcpStream;
use uuid::Uuid;

// Keep the HTTP driver alive exactly as long as its response body or tunnel.
struct ConnectionTask(tokio::task::JoinHandle<()>);
impl Drop for ConnectionTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct ProxyBody {
    inner: Body,
    progress: Option<tokio::sync::watch::Sender<()>>,
    _connection: Option<ConnectionTask>,
}
impl http_body::Body for ProxyBody {
    type Data = axum::body::Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let frame = std::pin::Pin::new(&mut self.inner).poll_frame(cx);
        if frame.is_ready() {
            if let Some(progress) = &self.progress {
                let _ = progress.send(());
            }
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

fn has_token(headers: &HeaderMap, name: &str, token: &str) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|v| v.trim().eq_ignore_ascii_case(token))
}
fn strip_hop_headers(headers: &mut HeaderMap) {
    let named = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().to_owned())
        .collect::<Vec<_>>();
    for name in named {
        headers.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(name);
    }
}

pub async fn forward(
    State(app): State<Shared>,
    Path(params): Path<HashMap<String, String>>,
    mut request: Request,
) -> Api<Response> {
    let id = params
        .get("id")
        .ok_or(Error(StatusCode::NOT_FOUND, "Session not found".into()))?;
    if Uuid::parse_str(id).is_err() {
        return Err(Error(StatusCode::NOT_FOUND, "Session not found".into()));
    }
    if request.method() == Method::CONNECT {
        return Err(Error(
            StatusCode::METHOD_NOT_ALLOWED,
            "CONNECT is not supported".into(),
        ));
    }
    let session = app.session(id).await?;
    let resolution =
        match tokio::time::timeout(Duration::from_secs(2), app.proxy_resolutions.acquire()).await {
            Ok(Ok(permit)) => permit,
            _ => {
                let mut response = Error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Session lookup is busy; retry shortly".into(),
                )
                .into_response();
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
                return Ok(response);
            }
        };
    let endpoint = app.backend(&session).await.map_err(|_| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Session is unavailable".into(),
        )
    })?;
    drop(resolution);
    let websocket = request.method() == Method::GET
        && has_token(request.headers(), "connection", "upgrade")
        && has_token(request.headers(), "upgrade", "websocket");
    let downstream = websocket.then(|| hyper::upgrade::on(&mut request));
    request.headers_mut().remove(header::COOKIE);
    request.headers_mut().remove("x-innkeeper-csrf");
    strip_hop_headers(request.headers_mut());
    // Prefixes are explicit Elsewhere configuration, never inferred from client headers.
    for name in [
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-prefix",
    ] {
        request.headers_mut().remove(name);
    }
    if websocket {
        request
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        request
            .headers_mut()
            .insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    }
    // Use origin-form upstream, including the complete public prefix and query.
    *request.uri_mut() = request
        .uri()
        .path_and_query()
        .context("Missing request path")?
        .as_str()
        .parse()
        .context("Invalid request path")?;
    *request.version_mut() = Version::HTTP_11;
    let stream = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(endpoint))
        .await
        .map_err(|_| {
            Error(
                StatusCode::GATEWAY_TIMEOUT,
                "Session connection timed out".into(),
            )
        })?
        .map_err(|_| Error(StatusCode::BAD_GATEWAY, "Cannot connect to session".into()))?;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(stream))
            .await
            .map_err(|_| Error(StatusCode::BAD_GATEWAY, "Session connection failed".into()))?;
    let mut connection = Some(ConnectionTask(tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    })));
    let (progress, mut upload) = tokio::sync::watch::channel(());
    let request = request.map(|inner| {
        Body::new(ProxyBody {
            inner,
            progress: Some(progress),
            _connection: None,
        })
    });
    let response = sender.send_request(request);
    tokio::pin!(response);
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut uploading = true;
    let mut response = loop {
        tokio::select! {
            result = &mut response => break result.map_err(|_| Error(StatusCode::BAD_GATEWAY, "Session request failed".into()))?,
            _ = tokio::time::sleep_until(deadline) => return Err(Error(StatusCode::GATEWAY_TIMEOUT, "Session request timed out".into())),
            changed = upload.changed(), if uploading => {
                uploading = changed.is_ok();
                // Active uploads may take arbitrarily long; stalled requests may not.
                deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            }
        }
    };
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        if !websocket
            || !has_token(response.headers(), "upgrade", "websocket")
            || !has_token(response.headers(), "connection", "upgrade")
        {
            return Err(Error(
                StatusCode::BAD_GATEWAY,
                "Unexpected session upgrade".into(),
            ));
        }
        let upstream = hyper::upgrade::on(&mut response);
        let downstream = downstream.unwrap();
        let connection = connection.take();
        tokio::spawn(async move {
            let _connection = connection;
            if let (Ok(upstream), Ok(downstream)) = tokio::join!(upstream, downstream) {
                let _ = tokio::io::copy_bidirectional(
                    &mut TokioIo::new(upstream),
                    &mut TokioIo::new(downstream),
                )
                .await;
            }
        });
        strip_hop_headers(response.headers_mut());
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        response
            .headers_mut()
            .insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    } else {
        strip_hop_headers(response.headers_mut());
    }
    response.headers_mut().remove("service-worker-allowed");
    response.headers_mut().remove(header::SET_COOKIE);
    Ok(response.map(|body| {
        Body::new(ProxyBody {
            inner: Body::new(body),
            progress: None,
            _connection: connection,
        })
    }))
}

// Keep the certificate stable across restarts. A missing half regenerates the pair.
fn load_or_create_cert(dir: &std::path::Path) -> Result<(Vec<u8>, Vec<u8>)> {
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    let cert = std::fs::read(&cert_path);
    let key = std::fs::read(&key_path);
    for result in [&cert, &key] {
        if let Err(error) = result {
            if error.kind() != std::io::ErrorKind::NotFound {
                bail!("Read saved HTTPS certificate or key: {error}");
            }
        }
    }
    if let (Ok(cert), Ok(key)) = (cert, key) {
        return Ok((cert, key));
    }
    let mut sans = vec!["localhost".into(), "127.0.0.1".into(), "::1".into()];
    sans.extend(if_addrs::get_if_addrs()?.iter().map(|i| i.ip().to_string()));
    sans.sort();
    sans.dedup();
    let mut params = rcgen::CertificateParams::new(sans)?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "elsewhere-innkeeper");
    let key = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key)?.pem().into_bytes();
    let key = key.serialize_pem().into_bytes();
    // If interrupted between writes, the missing key triggers regeneration.
    match std::fs::remove_file(&key_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    crate::private_write(&cert_path, &cert)?;
    crate::private_write(&key_path, &key)?;
    Ok((cert, key))
}

pub async fn serve(router: Router, dir: &std::path::Path) -> Result<()> {
    let addr: std::net::SocketAddr = env("INNKEEPER_LISTEN", "0.0.0.0:19300")
        .parse()
        .context("Invalid INNKEEPER_LISTEN")?;
    let cert = env("INNKEEPER_TLS_CERT", "");
    let key = env("INNKEEPER_TLS_KEY", "");
    if cert.is_empty() != key.is_empty() {
        bail!("Set both INNKEEPER_TLS_CERT and INNKEEPER_TLS_KEY");
    }
    let auto_tls = match env("INNKEEPER_TLS", "0").as_str() {
        "0" => false,
        "1" => true,
        _ => bail!("INNKEEPER_TLS must be 0 or 1"),
    };
    let pem = if !cert.is_empty() {
        Some((
            std::fs::read(cert).context("Read HTTPS certificate")?,
            std::fs::read(key).context("Read HTTPS key")?,
        ))
    } else if auto_tls {
        Some(load_or_create_cert(dir)?)
    } else {
        None
    };
    let handle = axum_server::Handle::new();
    let shutdown = handle.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Register SIGTERM");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        shutdown.graceful_shutdown(Some(Duration::from_secs(5)));
    });
    if let Some((cert, key)) = pem {
        use rustls::pki_types::{CertificateDer, pem::PemObject};
        use sha2::Digest;
        let der = CertificateDer::from_pem_slice(&cert).context("Parse HTTPS certificate")?;
        let fingerprint = sha2::Sha256::digest(&der)
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        let config = axum_server::tls_rustls::RustlsConfig::from_pem(cert, key)
            .await
            .context("Load HTTPS certificate and key")?;
        // WebSockets use the HTTP/1.1 upgrade tunnel on this listener.
        let mut tls = (*config.get_inner()).clone();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = axum_server::tls_rustls::RustlsConfig::from_config(std::sync::Arc::new(tls));
        eprintln!("certificate SHA-256: {fingerprint}");
        eprintln!("elsewhere-innkeeper listening on https://{addr}");
        axum_server::bind_rustls(addr, config)
            .handle(handle)
            .serve(router.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await?;
    } else {
        eprintln!("elsewhere-innkeeper listening on http://{addr}");
        axum_server::bind(addr)
            .handle(handle)
            .serve(router.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await?;
    }
    Ok(())
}
