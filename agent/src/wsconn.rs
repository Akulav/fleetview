//! Reaching the master through its web address (`https://fleetview.example.com`).
//!
//! The agent opens a WebSocket to `<address>/agent` and runs its normal
//! pinned-TLS session *inside* it. The outer layer (HTTPS to Cloudflare /
//! the reverse proxy, checked against the public CA roots) only gets the bytes
//! through firewalls and proxies; trust still comes from the inner TLS, which
//! pins the master's own certificate exactly like a direct connection. So a
//! proxy or CDN in the middle sees only ciphertext and can't impersonate the
//! master.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{ready, Context, Poll};
use std::time::Duration;

use anyhow::{Context as _, Result};
use futures_util::{Sink, Stream};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// Any byte stream the inner TLS can run over.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// Path of the master's agent endpoint, under its web address.
pub const AGENT_PATH: &str = "agent";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Whether a configured `master_address` is a web address (vs `host:port`).
pub fn is_url(address: &str) -> bool {
    let a = address.trim().to_ascii_lowercase();
    ["https://", "http://", "wss://", "ws://"]
        .iter()
        .any(|p| a.starts_with(p))
}

/// The WebSocket URL for a configured web address:
/// `https://host[:port][/base]` → `wss://host[:port][/base]/agent`.
pub fn agent_url(address: &str) -> Result<reqwest::Url> {
    let mut url =
        reqwest::Url::parse(address.trim()).context("master address is not a valid URL")?;
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => anyhow::bail!("unsupported scheme {other}"),
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("cannot use {address} as a WebSocket address"))?;
    let base = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{base}/{AGENT_PATH}"));
    url.set_query(None);
    url.set_fragment(None);
    if url.host_str().is_none() {
        anyhow::bail!("master address has no host");
    }
    Ok(url)
}

/// Open the WebSocket and return it as a plain byte stream.
pub async fn connect(address: &str) -> Result<Box<dyn Io>> {
    let url = agent_url(address)?;
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .context("connect timed out")?
        .with_context(|| format!("connect to {host}:{port}"))?;
    tcp.set_nodelay(true).ok();

    let mut request = url
        .as_str()
        .into_client_request()
        .context("WebSocket request")?;
    request.headers_mut().insert(
        "User-Agent",
        concat!("FleetView-Agent/", env!("CARGO_PKG_VERSION"))
            .parse()
            .expect("static header"),
    );

    if url.scheme() == "wss" {
        let connector = tokio_rustls::TlsConnector::from(public_tls_config());
        let name = rustls::pki_types::ServerName::try_from(host.clone()).context("server name")?;
        let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, tcp))
            .await
            .context("HTTPS handshake timed out")?
            .with_context(|| format!("HTTPS handshake with {host}"))?;
        let (ws, _) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::client_async(request, tls),
        )
        .await
        .context("WebSocket handshake timed out")?
        .context("WebSocket handshake (is the master running behind this address?)")?;
        Ok(Box::new(WsIo::new(ws)))
    } else {
        let (ws, _) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::client_async(request, tcp),
        )
        .await
        .context("WebSocket handshake timed out")?
        .context("WebSocket handshake (is the master running behind this address?)")?;
        Ok(Box::new(WsIo::new(ws)))
    }
}

/// HTTPS to the public address: ordinary certificate checks against the
/// public CA roots (Cloudflare, Let's Encrypt, …).
fn public_tls_config() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

/// A WebSocket as an `AsyncRead + AsyncWrite` byte stream: each write is one
/// binary message; reads concatenate binary messages.
struct WsIo<S> {
    ws: WebSocketStream<S>,
    buf: Vec<u8>,
    pos: usize,
    eof: bool,
}

impl<S> WsIo<S> {
    fn new(ws: WebSocketStream<S>) -> Self {
        Self {
            ws,
            buf: Vec::new(),
            pos: 0,
            eof: false,
        }
    }
}

fn to_io(e: tokio_tungstenite::tungstenite::Error) -> io::Error {
    io::Error::other(e)
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for WsIo<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            if self.pos < self.buf.len() {
                let n = out.remaining().min(self.buf.len() - self.pos);
                let pos = self.pos;
                out.put_slice(&self.buf[pos..pos + n]);
                self.pos += n;
                return Poll::Ready(Ok(()));
            }
            if self.eof {
                return Poll::Ready(Ok(()));
            }
            match ready!(Pin::new(&mut self.ws).poll_next(cx)) {
                Some(Ok(Message::Binary(data))) => {
                    self.buf = data;
                    self.pos = 0;
                }
                // Pings are answered by tungstenite itself; nothing else is used.
                Some(Ok(Message::Close(_))) | None => self.eof = true,
                Some(Ok(_)) => {}
                Some(Err(e)) => return Poll::Ready(Err(to_io(e))),
            }
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for WsIo<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        ready!(Pin::new(&mut self.ws).poll_ready(cx)).map_err(to_io)?;
        Pin::new(&mut self.ws)
            .start_send(Message::Binary(data.to_vec()))
            .map_err(to_io)?;
        Poll::Ready(Ok(data.len()))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.ws).poll_flush(cx).map_err(to_io)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.ws).poll_close(cx).map_err(to_io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_addresses_map_to_the_agent_endpoint() {
        assert!(is_url("https://fleetview.akulav.com"));
        assert!(is_url(" HTTP://10.0.0.5:8080/"));
        assert!(!is_url("fleetview.akulav.com:48620"));
        assert!(!is_url("192.168.1.10"));
        let u = |a| agent_url(a).unwrap().to_string();
        assert_eq!(
            u("https://fleetview.akulav.com"),
            "wss://fleetview.akulav.com/agent"
        );
        assert_eq!(
            u("https://fleetview.akulav.com/"),
            "wss://fleetview.akulav.com/agent"
        );
        assert_eq!(u("http://127.0.0.1:8080"), "ws://127.0.0.1:8080/agent");
        assert_eq!(
            u("https://example.org/fleet/"),
            "wss://example.org/fleet/agent"
        );
        assert!(agent_url("ftp://x").is_err());
    }
}
