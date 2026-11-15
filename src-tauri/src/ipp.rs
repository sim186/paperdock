//! Minimal IPP/1.1 client: just Get-Printer-Attributes, which every
//! network printer (HP, Canon, Epson, Brother, Xerox, ...) supports for
//! AirPrint/Mopria. Gives model, state and supply levels without any
//! vendor-specific API.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Int(i32),
    Bool(bool),
    Text(String),
    Other(Vec<u8>),
}

impl Value {
    fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }
    fn as_int(&self) -> Option<i32> {
        match self {
            Value::Int(i) => Some(*i),
            _ => None,
        }
    }
}

pub type Attributes = HashMap<String, Vec<Value>>;

const OP_GET_PRINTER_ATTRIBUTES: u16 = 0x000B;

fn push_attr(buf: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
    buf.push(tag);
    buf.extend_from_slice(&(name.len() as u16).to_be_bytes());
    buf.extend_from_slice(name.as_bytes());
    buf.extend_from_slice(&(value.len() as u16).to_be_bytes());
    buf.extend_from_slice(value);
}

pub fn encode_get_printer_attributes(printer_uri: &str, attrs: &[&str]) -> Vec<u8> {
    let mut b = vec![0x01, 0x01]; // IPP/1.1
    b.extend_from_slice(&OP_GET_PRINTER_ATTRIBUTES.to_be_bytes());
    b.extend_from_slice(&1u32.to_be_bytes());
    b.push(0x01); // operation-attributes-tag
    push_attr(&mut b, 0x47, "attributes-charset", b"utf-8");
    push_attr(&mut b, 0x48, "attributes-natural-language", b"en");
    push_attr(&mut b, 0x45, "printer-uri", printer_uri.as_bytes());
    for (i, a) in attrs.iter().enumerate() {
        // Additional values of a 1setOf have an empty name.
        let name = if i == 0 { "requested-attributes" } else { "" };
        push_attr(&mut b, 0x44, name, a.as_bytes());
    }
    b.push(0x03); // end-of-attributes
    b
}

/// Parse an IPP response into (status-code, attributes of all groups).
pub fn decode(data: &[u8]) -> Result<(u16, Attributes)> {
    let bad = || Error::Protocol("malformed IPP response".into());
    if data.len() < 8 {
        return Err(bad());
    }
    let status = u16::from_be_bytes([data[2], data[3]]);
    let mut attrs: Attributes = HashMap::new();
    let mut i = 8;
    let mut last = String::new();
    let read_u16 = |i: usize| -> Option<usize> {
        Some(u16::from_be_bytes([*data.get(i)?, *data.get(i + 1)?]) as usize)
    };
    while i < data.len() {
        let tag = data[i];
        i += 1;
        if tag == 0x03 {
            break;
        }
        if tag < 0x10 {
            continue; // group delimiter
        }
        let name_len = read_u16(i).ok_or_else(bad)?;
        i += 2;
        let name = data.get(i..i + name_len).ok_or_else(bad)?;
        i += name_len;
        let val_len = read_u16(i).ok_or_else(bad)?;
        i += 2;
        let raw = data.get(i..i + val_len).ok_or_else(bad)?;
        i += val_len;
        if !name.is_empty() {
            last = String::from_utf8_lossy(name).into_owned();
        }
        let value = match tag {
            0x21 | 0x23 if raw.len() == 4 => {
                Value::Int(i32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]))
            }
            0x22 if raw.len() == 1 => Value::Bool(raw[0] != 0),
            0x41..=0x49 | 0x35 | 0x36 => Value::Text(String::from_utf8_lossy(raw).into_owned()),
            _ => Value::Other(raw.to_vec()),
        };
        attrs.entry(last.clone()).or_default().push(value);
    }
    Ok((status, attrs))
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub name: String,
    /// CSS color like `#00FFFF`, when reported.
    pub color: Option<String>,
    pub kind: Option<String>,
    /// 0-100, or None when unknown (IPP reports -2/-3 for unknown/some).
    pub level: Option<u8>,
    pub low_level: Option<u8>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub make_and_model: Option<String>,
    pub name: Option<String>,
    pub location: Option<String>,
    /// idle | processing | stopped
    pub state: Option<String>,
    pub state_reasons: Vec<String>,
    pub state_message: Option<String>,
    pub markers: Vec<Marker>,
    pub duplex: bool,
    pub color: bool,
}

const WANTED: &[&str] = &[
    "printer-make-and-model",
    "printer-name",
    "printer-info",
    "printer-location",
    "printer-state",
    "printer-state-reasons",
    "printer-state-message",
    "marker-names",
    "marker-colors",
    "marker-types",
    "marker-levels",
    "marker-low-levels",
    "sides-supported",
    "color-supported",
];

pub fn summarize(a: &Attributes) -> PrinterInfo {
    let text = |k: &str| {
        a.get(k)
            .and_then(|v| v.first())
            .and_then(Value::as_text)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    let texts = |k: &str| -> Vec<String> {
        a.get(k)
            .map(|v| v.iter().filter_map(Value::as_text).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let ints = |k: &str| -> Vec<i32> {
        a.get(k)
            .map(|v| v.iter().filter_map(Value::as_int).collect())
            .unwrap_or_default()
    };
    let pct = |v: Option<&i32>| v.and_then(|&n| (0..=100).contains(&n).then_some(n as u8));

    let names = texts("marker-names");
    let colors = texts("marker-colors");
    let types = texts("marker-types");
    let levels = ints("marker-levels");
    let lows = ints("marker-low-levels");
    let markers = names
        .iter()
        .enumerate()
        .map(|(i, n)| Marker {
            name: n.clone(),
            color: colors.get(i).cloned().filter(|c| c.starts_with('#')),
            kind: types.get(i).cloned(),
            level: pct(levels.get(i)),
            low_level: pct(lows.get(i)),
        })
        .collect();

    let state = ints("printer-state").first().map(|s| match s {
        3 => "idle".to_string(),
        4 => "processing".to_string(),
        5 => "stopped".to_string(),
        n => n.to_string(),
    });

    PrinterInfo {
        make_and_model: text("printer-make-and-model"),
        name: text("printer-info").or_else(|| text("printer-name")),
        location: text("printer-location"),
        state,
        state_reasons: texts("printer-state-reasons")
            .into_iter()
            .filter(|r| r != "none")
            .collect(),
        state_message: text("printer-state-message"),
        markers,
        duplex: texts("sides-supported").iter().any(|s| s.starts_with("two-sided")),
        color: a
            .get("color-supported")
            .and_then(|v| v.first())
            .map(|v| *v == Value::Bool(true))
            .unwrap_or(false),
    }
}

fn http_client(timeout: Duration) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(4))
        .build()?)
}

/// Send one IPP request to `path` on the printer.
async fn post(http: &reqwest::Client, host: &str, path: &str, body: Vec<u8>) -> Result<(u16, Attributes)> {
    let url = format!("http://{host}:631/{path}");
    let resp = http
        .post(&url)
        .header("Content-Type", "application/ipp")
        .body(body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(Error::Status { status, url, detail: String::new() });
    }
    decode(&resp.bytes().await?)
}

/// Get-Printer-Attributes, trying the usual resource paths.
/// Returns the path that answered and the attributes.
async fn get_attributes(host: &str, resource: Option<&str>, wanted: &[&str]) -> Result<(String, Attributes)> {
    let http = http_client(Duration::from_secs(8))?;
    let mut paths: Vec<String> = Vec::new();
    if let Some(r) = resource {
        paths.push(r.trim_start_matches('/').to_string());
    }
    for p in ["ipp/print", "ipp/printer", "ipp", ""] {
        if !paths.iter().any(|x| x == p) {
            paths.push(p.to_string());
        }
    }
    let mut last_err = Error::Unsupported("ipp");
    for path in paths {
        let uri = format!("ipp://{host}:631/{path}");
        match post(&http, host, &path, encode_get_printer_attributes(&uri, wanted)).await {
            Ok((status, attrs)) if status < 0x0100 && attrs.contains_key("printer-state") => {
                return Ok((path, attrs));
            }
            Ok(_) | Err(Error::Status { .. }) => continue,
            Err(e) => {
                // Port closed: no point trying other paths.
                let closed = matches!(&e, Error::Http(h) if h.is_connect());
                last_err = e;
                if closed {
                    break;
                }
            }
        }
    }
    Err(last_err)
}

/// Query the printer, trying the usual resource paths.
pub async fn printer_info(host: &str, resource: Option<&str>) -> Result<PrinterInfo> {
    let (_, attrs) = get_attributes(host, resource, WANTED).await?;
    Ok(summarize(&attrs))
}

// ------------------------------------------------------------------ printing

const OP_GET_JOB_ATTRIBUTES: u16 = 0x0009;

/// Where a job is: IPP job-state 3 pending, 4 held, 5 processing,
/// 6 stopped, 7 canceled, 8 aborted, 9 completed.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub state: i32,
    pub reasons: Vec<String>,
    /// Sheets printed so far, when the printer counts them.
    pub sheets: Option<i32>,
}

pub fn encode_get_job_attributes(printer_uri: &str, job_id: i32) -> Vec<u8> {
    let mut b = vec![0x01, 0x01];
    b.extend_from_slice(&OP_GET_JOB_ATTRIBUTES.to_be_bytes());
    b.extend_from_slice(&1u32.to_be_bytes());
    b.push(0x01);
    push_attr(&mut b, 0x47, "attributes-charset", b"utf-8");
    push_attr(&mut b, 0x48, "attributes-natural-language", b"en");
    push_attr(&mut b, 0x45, "printer-uri", printer_uri.as_bytes());
    push_attr(&mut b, 0x21, "job-id", &job_id.to_be_bytes());
    for (i, a) in ["job-state", "job-state-reasons", "job-media-sheets-completed"].iter().enumerate() {
        push_attr(&mut b, 0x44, if i == 0 { "requested-attributes" } else { "" }, a.as_bytes());
    }
    b.push(0x03);
    b
}

pub async fn job_status(host: &str, resource: &str, job_id: i32) -> Result<JobStatus> {
    let http = http_client(Duration::from_secs(8))?;
    let path = resource.trim_start_matches('/');
    let uri = format!("ipp://{host}:631/{path}");
    let (status, a) = post(&http, host, path, encode_get_job_attributes(&uri, job_id)).await?;
    if status >= 0x0100 {
        return Err(Error::invalid_with("job_not_found", &[("status", format!("0x{status:04x}"))]));
    }
    let first_int = |k: &str| a.get(k).and_then(|v| v.first()).and_then(Value::as_int);
    Ok(JobStatus {
        state: first_int("job-state").unwrap_or(0),
        reasons: a
            .get("job-state-reasons")
            .map(|v| v.iter().filter_map(Value::as_text).map(str::to_string).collect())
            .unwrap_or_default(),
        sheets: first_int("job-media-sheets-completed"),
    })
}

const OP_PRINT_JOB: u16 = 0x0002;

/// What the print dialog may offer for this printer.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrintCaps {
    /// IPP resource path that answered, e.g. `ipp/print`.
    pub resource: String,
    pub pdf: bool,
    pub color: bool,
    /// print-color-mode values, e.g. `monochrome`, `color`.
    pub color_modes: Vec<String>,
    /// sides values, e.g. `one-sided`, `two-sided-long-edge`.
    pub sides: Vec<String>,
    /// IPP media names, e.g. `iso_a4_210x297mm`.
    pub media: Vec<String>,
    pub media_default: Option<String>,
    pub copies_max: u32,
}

const PRINT_WANTED: &[&str] = &[
    "printer-state",
    "document-format-supported",
    "color-supported",
    "print-color-mode-supported",
    "sides-supported",
    "media-supported",
    "media-default",
    "copies-supported",
];

pub fn print_caps_from(resource: String, a: &Attributes) -> PrintCaps {
    let texts = |k: &str| -> Vec<String> {
        a.get(k)
            .map(|v| v.iter().filter_map(Value::as_text).map(str::to_string).collect())
            .unwrap_or_default()
    };
    // copies-supported is a rangeOfInteger: 8 bytes, lower then upper bound.
    let copies_max = a
        .get("copies-supported")
        .and_then(|v| v.first())
        .and_then(|v| match v {
            Value::Other(b) if b.len() == 8 => Some(i32::from_be_bytes([b[4], b[5], b[6], b[7]])),
            Value::Int(i) => Some(*i),
            _ => None,
        })
        .filter(|&n| n >= 1)
        .map(|n| n.min(999) as u32)
        .unwrap_or(1);
    PrintCaps {
        resource,
        pdf: texts("document-format-supported").iter().any(|f| f.eq_ignore_ascii_case("application/pdf")),
        color: a
            .get("color-supported")
            .and_then(|v| v.first())
            .map(|v| *v == Value::Bool(true))
            .unwrap_or(false),
        color_modes: texts("print-color-mode-supported"),
        sides: texts("sides-supported"),
        media: texts("media-supported"),
        media_default: texts("media-default").into_iter().next(),
        copies_max,
    }
}

pub async fn print_caps(host: &str, resource: Option<&str>) -> Result<PrintCaps> {
    let (path, attrs) = get_attributes(host, resource, PRINT_WANTED).await?;
    Ok(print_caps_from(path, &attrs))
}

#[derive(serde::Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobOptions {
    pub job_name: Option<String>,
    pub copies: Option<u32>,
    /// print-color-mode keyword, sent only when set.
    pub color_mode: Option<String>,
    /// sides keyword, sent only when set.
    pub sides: Option<String>,
    /// IPP media name, sent only when set. Avoid it: some printers (HP M276n)
    /// abort the job ("aborted-by-system") when it is present.
    pub media: Option<String>,
}

pub fn encode_print_job(printer_uri: &str, opts: &JobOptions, pdf: &[u8]) -> Vec<u8> {
    let mut b = vec![0x01, 0x01]; // IPP/1.1: understood by every printer
    b.extend_from_slice(&OP_PRINT_JOB.to_be_bytes());
    b.extend_from_slice(&1u32.to_be_bytes());
    b.push(0x01);
    push_attr(&mut b, 0x47, "attributes-charset", b"utf-8");
    push_attr(&mut b, 0x48, "attributes-natural-language", b"en");
    push_attr(&mut b, 0x45, "printer-uri", printer_uri.as_bytes());
    push_attr(&mut b, 0x42, "requesting-user-name", b"PaperDock");
    let name: String = opts.job_name.as_deref().unwrap_or("PaperDock").chars().take(100).collect();
    push_attr(&mut b, 0x42, "job-name", name.as_bytes());
    push_attr(&mut b, 0x49, "document-format", b"application/pdf");
    b.push(0x02); // job-attributes-tag
    if let Some(c) = opts.copies.filter(|&c| c > 1) {
        push_attr(&mut b, 0x21, "copies", &(c as i32).to_be_bytes());
    }
    for (name, v) in [("print-color-mode", &opts.color_mode), ("sides", &opts.sides), ("media", &opts.media)] {
        if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
            push_attr(&mut b, 0x44, name, v.as_bytes());
        }
    }
    b.push(0x03);
    b.extend_from_slice(pdf);
    b
}

/// Send a PDF with Print-Job. Returns the job id when the printer gives one.
pub async fn print_pdf(host: &str, resource: &str, opts: &JobOptions, pdf: &[u8]) -> Result<Option<i32>> {
    // Big documents take a while to upload to a slow printer.
    let http = http_client(Duration::from_secs(300))?;
    let path = resource.trim_start_matches('/');
    let uri = format!("ipp://{host}:631/{path}");
    let (status, attrs) = post(&http, host, path, encode_print_job(&uri, opts, pdf)).await?;
    if status >= 0x0100 {
        let msg = attrs
            .get("status-message")
            .and_then(|v| v.first())
            .and_then(Value::as_text)
            .unwrap_or_default()
            .to_string();
        eprintln!("[ipp] Print-Job failed: 0x{status:04x} {msg}");
        return Err(Error::invalid_with("print_rejected", &[("status", format!("0x{status:04x}")), ("detail", msg)]));
    }
    Ok(attrs.get("job-id").and_then(|v| v.first()).and_then(Value::as_int))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_request_and_parse_response() {
        // A request is also a valid attribute stream; decode it back.
        let req = encode_get_printer_attributes("ipp://h:631/ipp/print", &["a", "b"]);
        let (_, attrs) = decode(&req).unwrap();
        assert_eq!(
            attrs["requested-attributes"],
            vec![Value::Text("a".into()), Value::Text("b".into())]
        );
        assert_eq!(attrs["printer-uri"], vec![Value::Text("ipp://h:631/ipp/print".into())]);
    }

    #[test]
    fn summarizes_markers() {
        let mut a = Attributes::new();
        a.insert("printer-state".into(), vec![Value::Int(3)]);
        a.insert(
            "marker-names".into(),
            vec![Value::Text("Black".into()), Value::Text("Cyan".into())],
        );
        a.insert(
            "marker-colors".into(),
            vec![Value::Text("#000000".into()), Value::Text("#00FFFF".into())],
        );
        a.insert("marker-levels".into(), vec![Value::Int(80), Value::Int(-3)]);
        a.insert("printer-state-reasons".into(), vec![Value::Text("none".into())]);
        let s = summarize(&a);
        assert_eq!(s.state.as_deref(), Some("idle"));
        assert!(s.state_reasons.is_empty());
        assert_eq!(s.markers[0].level, Some(80));
        assert_eq!(s.markers[1].level, None);
        assert_eq!(s.markers[1].color.as_deref(), Some("#00FFFF"));
    }

    #[test]
    fn print_job_carries_options_and_document() {
        let opts = JobOptions {
            job_name: Some("doc.pdf".into()),
            copies: Some(2),
            color_mode: Some("monochrome".into()),
            sides: None,
            media: Some("iso_a4_210x297mm".into()),
        };
        let req = encode_print_job("ipp://h:631/ipp/print", &opts, b"%PDF-1.4 x");
        assert_eq!(&req[2..4], &[0x00, 0x02]);
        assert!(req.ends_with(b"\x03%PDF-1.4 x"));
        let end = req.len() - b"%PDF-1.4 x".len();
        let (_, attrs) = decode(&req[..end]).unwrap();
        assert_eq!(attrs["copies"], vec![Value::Int(2)]);
        assert_eq!(attrs["print-color-mode"], vec![Value::Text("monochrome".into())]);
        assert_eq!(attrs["document-format"], vec![Value::Text("application/pdf".into())]);
        assert!(!attrs.contains_key("sides"));
    }

    #[test]
    fn print_caps_reads_ranges_and_formats() {
        let mut a = Attributes::new();
        a.insert(
            "document-format-supported".into(),
            vec![Value::Text("image/urf".into()), Value::Text("application/pdf".into())],
        );
        let mut range = 1i32.to_be_bytes().to_vec();
        range.extend_from_slice(&999i32.to_be_bytes());
        a.insert("copies-supported".into(), vec![Value::Other(range)]);
        a.insert("sides-supported".into(), vec![Value::Text("one-sided".into())]);
        let c = print_caps_from("ipp/print".into(), &a);
        assert!(c.pdf);
        assert_eq!(c.copies_max, 999);
        assert_eq!(c.sides, vec!["one-sided".to_string()]);
    }

    #[test]
    fn get_job_attributes_names_the_job() {
        let req = encode_get_job_attributes("ipp://h:631/ipp/print", 16);
        assert_eq!(&req[2..4], &[0x00, 0x09]);
        let (_, attrs) = decode(&req).unwrap();
        assert_eq!(attrs["job-id"], vec![Value::Int(16)]);
        assert_eq!(attrs["requested-attributes"].len(), 3);
    }

    #[test]
    fn rejects_truncated() {
        assert!(decode(&[1, 1, 0]).is_err());
        assert!(decode(&[1, 1, 0, 0, 0, 0, 0, 1, 0x47, 0, 50]).is_err());
    }
}
