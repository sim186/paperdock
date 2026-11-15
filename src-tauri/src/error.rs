use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors carry a stable `code` plus parameters so the UI can localize them.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("device returned HTTP {status} for {url}: {detail}")]
    Status { status: u16, url: String, detail: String },
    #[error("invalid XML from device: {0}")]
    Xml(#[from] roxmltree::Error),
    #[error("unexpected response: {0}")]
    Protocol(String),
    #[error("invalid input: {code}")]
    Invalid {
        code: &'static str,
        params: Vec<(&'static str, String)>,
    },
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("discovery error: {0}")]
    Mdns(#[from] mdns_sd::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
    #[error("feature not supported by this device: {0}")]
    Unsupported(&'static str),
}

impl Error {
    pub fn invalid(code: &'static str) -> Self {
        Error::Invalid { code, params: vec![] }
    }

    pub fn invalid_with(code: &'static str, params: &[(&'static str, String)]) -> Self {
        Error::Invalid { code, params: params.to_vec() }
    }

    fn code(&self) -> &'static str {
        match self {
            Error::Http(e) if e.is_timeout() => "timeout",
            Error::Http(e) if e.is_connect() => "unreachable",
            Error::Http(_) => "network",
            Error::Status { .. } => "http_status",
            Error::Xml(_) | Error::Protocol(_) => "protocol",
            Error::Invalid { code, .. } => code,
            Error::Io(_) => "io",
            Error::Mdns(_) => "discovery",
            Error::Image(_) => "image",
            Error::Unsupported(_) => "unsupported",
        }
    }

    /// Parameters for the localized message.
    fn params(&self) -> Vec<(&'static str, String)> {
        match self {
            Error::Status { status, .. } => vec![("status", status.to_string())],
            Error::Invalid { params, .. } => params.clone(),
            Error::Unsupported(f) => vec![("feature", f.to_string())],
            _ => vec![],
        }
    }
}

/// Serialized as `{ code, message, params }`: `code` and `params` drive the
/// localized UI text, `message` is an English fallback with details.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let params: std::collections::BTreeMap<&str, String> = self.params().into_iter().collect();
        let mut st = s.serialize_struct("Error", 3)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("params", &params)?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;
