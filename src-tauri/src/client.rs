use std::time::Duration;

use crate::error::{Error, Result};

/// Thin HTTP wrapper bound to one printer host.
#[derive(Clone)]
pub struct Printer {
    http: reqwest::Client,
    base: String,
    escl_root: String,
}

pub struct Created {
    pub location: Option<String>,
}

impl Printer {
    pub fn new(host: &str) -> Result<Self> {
        let host = host.trim().trim_end_matches('/');
        if host.is_empty() {
            return Err(Error::invalid("host_empty"));
        }
        let base = if host.starts_with("http://") || host.starts_with("https://") {
            host.to_string()
        } else {
            format!("http://{host}")
        };
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self { http, base, escl_root: "/eSCL".into() })
    }

    /// eSCL resource root (`rs` TXT record), e.g. `eSCL` or `/scan/eSCL`.
    pub fn with_escl_root(mut self, root: Option<&str>) -> Self {
        if let Some(r) = root.map(|r| r.trim().trim_matches('/')).filter(|r| !r.is_empty()) {
            self.escl_root = format!("/{r}");
        }
        self
    }

    pub fn escl_root(&self) -> &str {
        &self.escl_root
    }

    /// Host without scheme/port (IPv6 keeps brackets), for IPP on :631.
    pub fn host_name(&self) -> String {
        reqwest::Url::parse(&self.base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| self.base.clone())
    }

    pub fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}{}", self.base, path)
        }
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
        let status = resp.status();
        if status.is_success() {
            Ok(resp)
        } else {
            let url = resp.url().to_string();
            let body = resp.text().await.unwrap_or_default();
            let detail: String = body.trim().chars().take(400).collect();
            eprintln!("[http] {} {url}: {detail}", status.as_u16());
            Err(Error::Status { status: status.as_u16(), url, detail })
        }
    }

    pub async fn get_text(&self, path: &str) -> Result<String> {
        // Status reads should fail fast; scans use get_raw with the long timeout.
        let resp = self
            .http
            .get(self.url(path))
            .timeout(Duration::from_secs(12))
            .send()
            .await?;
        Ok(Self::check(resp).await?.text().await?)
    }

    /// GET returning status and body without failing on non-2xx
    /// (eSCL uses 404/503 as flow control while a job runs).
    pub async fn get_raw(&self, path: &str) -> Result<(u16, Vec<u8>)> {
        let resp = self.http.get(self.url(path)).send().await?;
        let status = resp.status().as_u16();
        Ok((status, resp.bytes().await?.to_vec()))
    }

    pub async fn post_xml(&self, path: &str, body: String) -> Result<Created> {
        let resp = self
            .http
            .post(self.url(path))
            .header("Content-Type", "text/xml")
            .body(body)
            .send()
            .await?;
        let resp = Self::check(resp).await?;
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        Ok(Created { location })
    }

    pub async fn put_xml(&self, path: &str, body: String) -> Result<()> {
        let resp = self
            .http
            .put(self.url(path))
            .header("Content-Type", "text/xml")
            .body(body)
            .send()
            .await?;
        Self::check(resp).await?;
        Ok(())
    }

    pub async fn delete(&self, path: &str) -> Result<()> {
        let resp = self.http.delete(self.url(path)).send().await?;
        Self::check(resp).await?;
        Ok(())
    }
}
