use crate::{Api, Error, Shared, env};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::Body,
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Version, header},
    response::Response,
};
use hyper_util::rt::TokioIo;
use std::{collections::HashMap, time::Duration};
use tokio::net::TcpStream;
use uuid::Uuid;

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
    let endpoint = app.backend(&session).await.map_err(|_| {
        Error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Session is unavailable".into(),
        )
    })?;
    let websocket = request.method() == Method::GET
        && has_token(request.headers(), "connection", "upgrade")
        && has_token(request.headers(), "upgrade", "websocket");
    let downstream = websocket.then(|| hyper::upgrade::on(&mut request));
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
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    let mut response = sender
        .send_request(request)
        .await
        .map_err(|_| Error(StatusCode::BAD_GATEWAY, "Session request failed".into()))?;
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
        tokio::spawn(async move {
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
    Ok(response.map(Body::new))
}

pub async fn serve(router: Router) -> Result<()> {
    let addr: std::net::SocketAddr = env("INNKEEPER_LISTEN", "0.0.0.0:19300")
        .parse()
        .context("Invalid INNKEEPER_LISTEN")?;
    let cert = env("INNKEEPER_TLS_CERT", "");
    let key = env("INNKEEPER_TLS_KEY", "");
    if cert.is_empty() != key.is_empty() {
        bail!("Set both INNKEEPER_TLS_CERT and INNKEEPER_TLS_KEY");
    }
    let handle = axum_server::Handle::new();
    let shutdown = handle.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Register SIGTERM");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        shutdown.graceful_shutdown(Some(Duration::from_secs(5)));
    });
    if cert.is_empty() {
        eprintln!("elsewhere-innkeeper listening on http://{addr}");
        axum_server::bind(addr)
            .handle(handle)
            .serve(router.into_make_service())
            .await?;
    } else {
        let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
            .await
            .context("Load HTTPS certificate and key")?;
        // WebSockets use the HTTP/1.1 upgrade tunnel on this listener.
        let mut tls = (*config.get_inner()).clone();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = axum_server::tls_rustls::RustlsConfig::from_config(std::sync::Arc::new(tls));
        eprintln!("elsewhere-innkeeper listening on https://{addr}");
        axum_server::bind_rustls(addr, config)
            .handle(handle)
            .serve(router.into_make_service())
            .await?;
    }
    Ok(())
}
