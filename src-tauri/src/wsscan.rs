//! WS-Scan (Microsoft "Web Services for Devices" scanning): the protocol
//! Windows uses out of the box. Many devices that lack a usable eSCL speak
//! it (e.g. the HP M276n, whose eSCL is a cloud-only variant).
//!
//! Flow: WS-Discovery unicast Probe (UDP 3702) -> device endpoint + metadata
//! address -> WS-Transfer Get -> scanner service URL -> GetScannerElements /
//! CreateScanJob / RetrieveImage (MTOM multipart) until no images remain.

use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use roxmltree::{Document, Node};

use crate::error::{Error, Result};
use crate::escl::{InputCaps, Paper, ScanRequest, ScannerCaps, ScannerStatus, Source};
use crate::xml::{children, descendants, escape, find, text};

const NS_SCAN: &str = "http://schemas.microsoft.com/windows/2006/08/wdp/scan";
const NS_WSA: &str = "http://schemas.xmlsoap.org/ws/2004/08/addressing";
const ANONYMOUS: &str = "http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous";

fn message_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let h = format!("{:032x}", n ^ ((c as u128) << 64));
    format!("urn:uuid:{}-{}-4{}-8{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

fn envelope(to: &str, action: &str, body: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="utf-8"?>"#,
            r#"<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="{wsa}" xmlns:sca="{sca}">"#,
            "<soap:Header><wsa:To>{to}</wsa:To><wsa:Action>{action}</wsa:Action>",
            "<wsa:MessageID>{id}</wsa:MessageID>",
            "<wsa:ReplyTo><wsa:Address>{anon}</wsa:Address></wsa:ReplyTo></soap:Header>",
            "<soap:Body>{body}</soap:Body></soap:Envelope>",
        ),
        wsa = NS_WSA,
        sca = NS_SCAN,
        to = escape(to),
        action = action,
        id = message_id(),
        anon = ANONYMOUS,
        body = body,
    )
}

fn action(name: &str) -> String {
    format!("{NS_SCAN}/{name}")
}

/// SOAP fault subcode (e.g. `ClientErrorNoImagesAvailable`), local part only.
pub fn fault_code(xml: &str) -> Option<String> {
    let doc = Document::parse(xml).ok()?;
    let fault = find(doc.root_element(), "Fault")?;
    let sub = find(fault, "Subcode").and_then(|s| text(s, "Value"));
    let code = sub.or_else(|| find(fault, "Code").and_then(|c| text(c, "Value")))?;
    Some(code.rsplit(':').next().unwrap_or(&code).to_string())
}

// ------------------------------------------------------------- discovery

/// Endpoint reference and metadata addresses from a WS-Discovery ProbeMatch.
#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub epr: String,
    pub xaddrs: Vec<String>,
}

pub fn parse_probe_match(xml: &str) -> Option<Endpoint> {
    let doc = Document::parse(xml).ok()?;
    let pm = find(doc.root_element(), "ProbeMatch")?;
    let epr = find(pm, "EndpointReference").and_then(|e| text(e, "Address"))?;
    let types = text(pm, "Types").unwrap_or_default();
    if !types.contains("ScanDeviceType") {
        return None;
    }
    let xaddrs = text(pm, "XAddrs")
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    Some(Endpoint { epr, xaddrs })
}

/// Unicast WS-Discovery probe to a known host (blocking, short timeout).
fn probe(host: &str) -> Result<Endpoint> {
    // Some firmware (HP M276n) silently drops probes that carry ReplyTo or
    // declare the type prefix on the Probe element: keep it minimal.
    let msg = format!(
        concat!(
            r#"<?xml version="1.0" encoding="utf-8"?>"#,
            r#"<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" "#,
            r#"xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" "#,
            r#"xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" "#,
            r#"xmlns:wscn="http://schemas.microsoft.com/windows/2006/08/wdp/scan">"#,
            "<soap:Header><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>",
            "<wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>",
            "<wsa:MessageID>{id}</wsa:MessageID></soap:Header>",
            "<soap:Body><wsd:Probe><wsd:Types>wscn:ScanDeviceType</wsd:Types></wsd:Probe></soap:Body>",
            "</soap:Envelope>"
        ),
        id = message_id()
    );
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.');
    let sock = UdpSocket::bind(if host.contains(':') { "[::]:0" } else { "0.0.0.0:0" })?;
    sock.set_read_timeout(Some(Duration::from_millis(700)))?;
    let target = if host.contains(':') { format!("[{host}]:3702") } else { format!("{host}:3702") };
    let mut buf = vec![0u8; 65535];
    // UDP: retry a few times.
    for _ in 0..4 {
        sock.send_to(msg.as_bytes(), &target)?;
        match sock.recv_from(&mut buf) {
            Ok((n, _)) => {
                let reply = String::from_utf8_lossy(&buf[..n]);
                if let Some(ep) = parse_probe_match(&reply) {
                    return Ok(ep);
                }
                eprintln!("[wsscan] unexpected probe reply: {}", reply.chars().take(300).collect::<String>());
            }
            Err(e) => eprintln!("[wsscan] probe {target}: {e}"),
        }
    }
    Err(Error::Unsupported("wsscan"))
}

/// From WS-Transfer Get metadata, the scanner service addresses.
pub fn parse_scanner_service(xml: &str) -> Vec<String> {
    let Ok(doc) = Document::parse(xml) else { return vec![] };
    descendants(doc.root_element(), "Hosted")
        .filter(|h| text(*h, "Types").map(|t| t.contains("ScannerServiceType")).unwrap_or(false))
        .flat_map(|h| {
            descendants(h, "Address")
                .filter_map(|a| a.text().map(|t| t.trim().to_string()))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// How long to wait for a page after the first before asking the scanner
/// whether the job is over.
const NEXT_PAGE_WAIT: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct WsScanner {
    http: reqwest::Client,
    pub url: String,
}

fn pick_address(addrs: &[String], host: &str) -> Option<String> {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    addrs
        .iter()
        .find(|a| a.to_ascii_lowercase().contains(&h))
        .or_else(|| addrs.iter().find(|a| !a.contains('[')))
        .or_else(|| addrs.first())
        .cloned()
}

impl WsScanner {
    pub fn new(url: String) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(120))
            .build()?;
        Ok(Self { http, url })
    }

    /// Find the scanner service of `host` (IP or name).
    pub async fn locate(host: &str) -> Result<Self> {
        let h = host.to_string();
        let ep = tokio::task::spawn_blocking(move || probe(&h))
            .await
            .map_err(|e| Error::Protocol(e.to_string()))??;
        let meta = pick_address(&ep.xaddrs, host).ok_or(Error::Unsupported("wsscan"))?;
        let http = reqwest::Client::builder().timeout(Duration::from_secs(8)).build()?;
        let body = envelope(&ep.epr, "http://schemas.xmlsoap.org/ws/2004/09/transfer/Get", "");
        let xml = http
            .post(&meta)
            .header("Content-Type", "application/soap+xml; charset=utf-8")
            .body(body)
            .send()
            .await?
            .text()
            .await?;
        let addrs = parse_scanner_service(&xml);
        let url = pick_address(&addrs, host).ok_or(Error::Unsupported("wsscan"))?;
        Self::new(url)
    }

    async fn call(&self, name: &str, body: &str) -> Result<reqwest::Response> {
        Ok(self
            .http
            .post(&self.url)
            .header("Content-Type", "application/soap+xml; charset=utf-8")
            .body(envelope(&self.url, &action(name), body))
            .send()
            .await?)
    }

    async fn call_xml(&self, name: &str, body: &str) -> Result<String> {
        let resp = self.call(name, body).await?;
        let status = resp.status().as_u16();
        let xml = resp.text().await?;
        if let Some(code) = fault_code(&xml) {
            eprintln!("[wsscan] {name} fault: {code}");
            return Err(fault_error(&code, status));
        }
        Ok(xml)
    }

    pub async fn elements(&self) -> Result<(ScannerCaps, ScannerStatus, Vec<String>)> {
        let xml = self
            .call_xml(
                "GetScannerElements",
                concat!(
                    "<sca:GetScannerElementsRequest><sca:RequestedElements>",
                    "<sca:Name>sca:ScannerDescription</sca:Name>",
                    "<sca:Name>sca:ScannerConfiguration</sca:Name>",
                    "<sca:Name>sca:ScannerStatus</sca:Name>",
                    "</sca:RequestedElements></sca:GetScannerElementsRequest>"
                ),
            )
            .await?;
        parse_elements(&xml)
    }

    pub async fn status(&self) -> Result<ScannerStatus> {
        let xml = self
            .call_xml(
                "GetScannerElements",
                concat!(
                    "<sca:GetScannerElementsRequest><sca:RequestedElements>",
                    "<sca:Name>sca:ScannerStatus</sca:Name>",
                    "</sca:RequestedElements></sca:GetScannerElementsRequest>"
                ),
            )
            .await?;
        Ok(parse_elements(&xml)?.1)
    }

    /// Scan all pages (feeder) or one page (glass). Returns raw images in
    /// the device format (JPEG or PNG); callers normalize them.
    pub async fn scan(
        &self,
        req: &ScanRequest,
        cancel: &AtomicBool,
        mut on_page: impl FnMut(usize),
    ) -> Result<Vec<Vec<u8>>> {
        let (caps, status, formats) = self.elements().await?;
        if status.state != "Idle" {
            return Err(Error::invalid_with("scanner_busy", &[("state", status.state)]));
        }
        let ticket = scan_ticket(&caps, &formats, req)?;
        let xml = self.call_xml("CreateScanJob", &ticket).await?;
        let doc = Document::parse(&xml)?;
        let resp = find(doc.root_element(), "CreateScanJobResponse")
            .ok_or_else(|| Error::Protocol("no CreateScanJobResponse".into()))?;
        let job_id = text(resp, "JobId").ok_or_else(|| Error::Protocol("no JobId".into()))?;
        let token = text(resp, "JobToken").ok_or_else(|| Error::Protocol("no JobToken".into()))?;
        eprintln!("[wsscan] job {job_id} created");

        let mut pages = Vec::new();
        let mut busy_retries = 0;
        loop {
            if cancel.load(Ordering::SeqCst) {
                self.cancel(&job_id).await;
                return Err(Error::invalid("cancelled"));
            }
            let body = format!(
                concat!(
                    "<sca:RetrieveImageRequest><sca:JobId>{id}</sca:JobId>",
                    "<sca:JobToken>{token}</sca:JobToken>",
                    "<sca:DocumentDescription><sca:DocumentName>page{n}</sca:DocumentName></sca:DocumentDescription>",
                    "</sca:RetrieveImageRequest>"
                ),
                id = escape(&job_id),
                token = escape(&token),
                n = pages.len() + 1,
            );
            // After the first page the device sometimes never answers the
            // request for the next one (feeder ran out) instead of faulting.
            let wait = if pages.is_empty() { Duration::from_secs(115) } else { NEXT_PAGE_WAIT };
            let fetched = tokio::select! {
                r = tokio::time::timeout(wait, self.call("RetrieveImage", &body)) => Some(r),
                _ = crate::escl::cancelled(cancel) => None,
            };
            let Some(resp) = fetched else {
                self.cancel(&job_id).await;
                return Err(Error::invalid("cancelled"));
            };
            let resp = match resp {
                Ok(r) => r,
                Err(_) if !pages.is_empty() => {
                    let state = self.elements().await.map(|(_, st, _)| st.state);
                    eprintln!("[wsscan] no answer for page {} after {wait:?}; scanner {state:?}", pages.len() + 1);
                    if matches!(state.as_deref(), Ok("Idle")) {
                        self.cancel(&job_id).await;
                        break;
                    }
                    continue;
                }
                Err(_) => {
                    eprintln!("[wsscan] no answer for the first page");
                    self.cancel(&job_id).await;
                    return Err(Error::Protocol("scanner did not send the page".into()));
                }
            };
            let resp = resp.map_err(|e| {
                eprintln!("[wsscan] RetrieveImage failed: {e}");
                e
            })?;
            let status = resp.status().as_u16();
            let ctype = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let bytes = resp.bytes().await?;
            if let Some(image) = mtom_image(&ctype, &bytes) {
                eprintln!("[wsscan] page {} ({} bytes)", pages.len() + 1, image.len());
                pages.push(image);
                busy_retries = 0;
                on_page(pages.len());
                if req.source == Source::Platen {
                    break;
                }
                continue;
            }
            let xml = String::from_utf8_lossy(&bytes);
            let fault = fault_code(&xml);
            eprintln!("[wsscan] RetrieveImage HTTP {status}: {}", fault.as_deref().unwrap_or("no image, no fault"));
            match fault.as_deref() {
                // Feeder empty: job done.
                Some("ClientErrorNoImagesAvailable") | Some("ClientErrorJobIdNotFound") if !pages.is_empty() => break,
                Some("ClientErrorNoImagesAvailable") => return Err(Error::invalid("adf_empty")),
                Some("ServerErrorTemporaryError") | Some("ServerErrorNotAcceptingJobs") if busy_retries < 40 => {
                    busy_retries += 1;
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Some(code) => {
                    self.cancel(&job_id).await;
                    return Err(fault_error(code, status));
                }
                None => {
                    self.cancel(&job_id).await;
                    return Err(Error::Protocol(format!("unexpected RetrieveImage reply ({ctype})")));
                }
            }
        }
        Ok(pages)
    }

    async fn cancel(&self, job_id: &str) {
        let body = format!("<sca:CancelJobRequest><sca:JobId>{}</sca:JobId></sca:CancelJobRequest>", escape(job_id));
        let _ = self.call("CancelJob", &body).await;
    }
}

fn fault_error(code: &str, status: u16) -> Error {
    match code {
        "ClientErrorNoImagesAvailable" => Error::invalid("adf_empty"),
        "ServerErrorNotAcceptingJobs" | "ServerErrorTemporaryError" => {
            Error::invalid_with("scanner_busy", &[("state", code.to_string())])
        }
        _ => Error::Status { status, url: "ws-scan".into(), detail: code.to_string() },
    }
}

// --------------------------------------------------------- capabilities

fn num(node: Node, name: &str) -> Option<u32> {
    text(node, name).and_then(|v| v.parse().ok())
}

/// thousandths of an inch -> 1/300 inch (eSCL units used by the UI).
fn to_300(v: u32) -> u32 {
    v * 300 / 1000
}

fn input_caps(cfg: Node, prefix: &str) -> Option<InputCaps> {
    let section = children(cfg, prefix).next()?;
    let max = find(section, &format!("{prefix}MaximumSize"))?;
    let front = find(section, &format!("{prefix}Front")).unwrap_or(section);
    let res_node = find(front, "Widths");
    let mut resolutions: Vec<u32> = res_node
        .map(|w| children(w, "Width").filter_map(|n| n.text()?.trim().parse().ok()).collect())
        .unwrap_or_default();
    resolutions.sort_unstable();
    resolutions.dedup();
    Some(InputCaps {
        max_width: to_300(num(max, "Width")?),
        max_height: to_300(num(max, "Height")?),
        resolutions,
    })
}

pub fn parse_elements(xml: &str) -> Result<(ScannerCaps, ScannerStatus, Vec<String>)> {
    let doc = Document::parse(xml)?;
    let root = doc.root_element();
    let cfg = find(root, "ScannerConfiguration")
        .ok_or_else(|| Error::Protocol("no ScannerConfiguration".into()))
        .ok();
    let st = find(root, "ScannerStatus");
    let status = ScannerStatus {
        state: st.and_then(|s| text(s, "ScannerState")).unwrap_or_else(|| "Unknown".into()),
        adf_state: None,
    };
    let Some(cfg) = cfg else {
        // Status-only reply.
        return Ok((
            ScannerCaps {
                make_and_model: None,
                namespace: NS_SCAN.into(),
                version: "wsscan".into(),
                color_modes: vec![],
                platen: None,
                adf: None,
                adf_duplex: false,
                adf_capacity: None,
            },
            status,
            vec![],
        ));
    };
    let mut colors: Vec<String> = descendants(cfg, "ColorEntry")
        .filter_map(|c| c.text().map(|t| t.trim().to_string()))
        .collect();
    colors.sort_by_key(|c| match c.as_str() {
        "RGB24" => 0,
        "Grayscale8" => 1,
        _ => 2,
    });
    colors.dedup();
    let formats: Vec<String> = descendants(cfg, "FormatValue")
        .filter_map(|c| c.text().map(|t| t.trim().to_string()))
        .collect();
    let desc = find(root, "ScannerDescription");
    let caps = ScannerCaps {
        make_and_model: desc.and_then(|d| text(d, "ScannerName")).filter(|s| !s.is_empty()),
        namespace: NS_SCAN.into(),
        version: "wsscan".into(),
        color_modes: colors,
        platen: input_caps(cfg, "Platen"),
        adf: input_caps(cfg, "ADF"),
        adf_duplex: text(cfg, "ADFSupportsDuplex").as_deref() == Some("true"),
        adf_capacity: None,
    };
    Ok((caps, status, formats))
}

/// Paper size in thousandths of an inch.
fn paper_1000(p: Paper, max_w: u32, max_h: u32) -> (u32, u32) {
    let (w, h) = match p {
        Paper::A4 => (8267, 11692),
        Paper::Letter => (8500, 11000),
        Paper::Legal => (8500, 14000),
        Paper::Max => (max_w, max_h),
    };
    (w.min(max_w), h.min(max_h))
}

pub fn scan_ticket(caps: &ScannerCaps, formats: &[String], req: &ScanRequest) -> Result<String> {
    let input = match req.source {
        Source::Platen => caps.platen.as_ref(),
        Source::Feeder => caps.adf.as_ref(),
    }
    .ok_or_else(|| Error::invalid_with("no_source", &[("source", format!("{:?}", req.source))]))?;
    if !input.resolutions.is_empty() && !input.resolutions.contains(&req.resolution) {
        return Err(Error::invalid_with(
            "unsupported_value",
            &[("field", "resolution".into()), ("value", req.resolution.to_string())],
        ));
    }
    if !caps.color_modes.is_empty() && !caps.color_modes.contains(&req.color_mode) {
        return Err(Error::invalid_with(
            "unsupported_value",
            &[("field", "colorMode".into()), ("value", req.color_mode.clone())],
        ));
    }
    if req.duplex && (req.source != Source::Feeder || !caps.adf_duplex) {
        return Err(Error::Unsupported("duplex"));
    }
    // Prefer JPEG; otherwise whatever the device offers (we convert later).
    let format = ["jfif", "exif", "png", "tiff-single-uncompressed"]
        .iter()
        .find(|f| formats.iter().any(|x| x == *f))
        .map(|s| s.to_string())
        .or_else(|| formats.first().cloned())
        .unwrap_or_else(|| "jfif".into());
    let max_w = input.max_width * 1000 / 300;
    let max_h = input.max_height * 1000 / 300;
    let (w, h) = paper_1000(req.paper, max_w, max_h);
    let source = match (req.source, req.duplex) {
        (Source::Platen, _) => "Platen",
        (Source::Feeder, false) => "ADF",
        (Source::Feeder, true) => "ADFDuplex",
    };
    let side = |tag: &str| {
        format!(
            concat!(
                "<sca:{tag}>",
                "<sca:ScanRegion><sca:ScanRegionXOffset>0</sca:ScanRegionXOffset>",
                "<sca:ScanRegionYOffset>0</sca:ScanRegionYOffset>",
                "<sca:ScanRegionWidth>{w}</sca:ScanRegionWidth>",
                "<sca:ScanRegionHeight>{h}</sca:ScanRegionHeight></sca:ScanRegion>",
                "<sca:ColorProcessing>{color}</sca:ColorProcessing>",
                "<sca:Resolution><sca:Width>{r}</sca:Width><sca:Height>{r}</sca:Height></sca:Resolution>",
                "</sca:{tag}>"
            ),
            tag = tag,
            w = w,
            h = h,
            color = escape(&req.color_mode),
            r = req.resolution,
        )
    };
    let sides = if req.duplex {
        format!("{}{}", side("MediaFront"), side("MediaBack"))
    } else {
        side("MediaFront")
    };
    Ok(format!(
        concat!(
            "<sca:CreateScanJobRequest><sca:ScanTicket>",
            "<sca:JobDescription><sca:JobName>PaperDock</sca:JobName>",
            "<sca:JobOriginatingUserName>PaperDock</sca:JobOriginatingUserName></sca:JobDescription>",
            "<sca:DocumentParameters>",
            "<sca:Format>{format}</sca:Format>",
            "<sca:ImagesToTransfer>{images}</sca:ImagesToTransfer>",
            "<sca:InputSource>{source}</sca:InputSource>",
            "<sca:InputSize><sca:InputMediaSize><sca:Width>{w}</sca:Width><sca:Height>{h}</sca:Height></sca:InputMediaSize></sca:InputSize>",
            "<sca:MediaSides>{sides}</sca:MediaSides>",
            "</sca:DocumentParameters></sca:ScanTicket></sca:CreateScanJobRequest>"
        ),
        format = escape(&format),
        // 0 = all images in the feeder.
        images = if req.source == Source::Platen { 1 } else { 0 },
        source = source,
        w = w,
        h = h,
        sides = sides,
    ))
}

// ------------------------------------------------------------------ MTOM

/// Extract the binary image part of an MTOM/XOP multipart response.
pub fn mtom_image(content_type: &str, body: &[u8]) -> Option<Vec<u8>> {
    let ct = content_type.to_ascii_lowercase();
    if !ct.starts_with("multipart/") {
        return None;
    }
    let boundary = content_type
        .split(';')
        .map(str::trim)
        .find_map(|p| {
            let (k, v) = p.split_once('=')?;
            k.trim().eq_ignore_ascii_case("boundary").then(|| v.trim().trim_matches('"').to_string())
        })?;
    let delim = format!("--{boundary}");
    let d = delim.as_bytes();
    // Split body on the delimiter.
    let mut parts = Vec::new();
    let mut start = None;
    let mut i = 0;
    while i + d.len() <= body.len() {
        if &body[i..i + d.len()] == d {
            if let Some(s) = start {
                parts.push(&body[s..i]);
            }
            start = Some(i + d.len());
            i += d.len();
        } else {
            i += 1;
        }
    }
    for part in parts {
        let sep = part.windows(4).position(|w| w == b"\r\n\r\n")?;
        let headers = String::from_utf8_lossy(&part[..sep]).to_ascii_lowercase();
        let mut content = &part[sep + 4..];
        if content.ends_with(b"\r\n") {
            content = &content[..content.len() - 2];
        }
        let is_xml = headers.contains("xml");
        if !is_xml && !content.is_empty() {
            return Some(content.to_vec());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const ELEMENTS: &str = include_str!("../tests/fixtures/wsscan_m276n_elements.xml");

    #[test]
    fn parses_real_m276n_capabilities() {
        let (caps, status, formats) = parse_elements(ELEMENTS).unwrap();
        assert_eq!(status.state, "Idle");
        assert_eq!(formats, vec!["png"]);
        assert!(caps.color_modes.contains(&"RGB24".to_string()));
        assert!(!caps.adf_duplex);
        let adf = caps.adf.unwrap();
        assert_eq!(adf.max_width, 2480);
        assert_eq!(adf.resolutions, vec![75, 150, 300]);
        assert!(caps.platen.is_some());
    }

    #[test]
    fn builds_ticket_for_feeder() {
        let (caps, _, formats) = parse_elements(ELEMENTS).unwrap();
        let req = ScanRequest {
            source: Source::Feeder,
            color_mode: "Grayscale8".into(),
            resolution: 150,
            paper: Paper::A4,
            duplex: false,
        };
        let t = scan_ticket(&caps, &formats, &req).unwrap();
        assert!(t.contains("<sca:InputSource>ADF</sca:InputSource>"));
        assert!(t.contains("<sca:Format>png</sca:Format>"));
        assert!(t.contains("<sca:ImagesToTransfer>0</sca:ImagesToTransfer>"));
        assert!(t.contains("<sca:Width>150</sca:Width>"));
        let wrapped = format!(r#"<r xmlns:sca="{NS_SCAN}">{t}</r>"#);
        Document::parse(&wrapped).unwrap();
        let mut dup = req;
        dup.duplex = true;
        assert!(scan_ticket(&caps, &formats, &dup).is_err());
    }

    #[test]
    fn parses_probe_match_and_metadata() {
        let pm = r#"<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:abc</a:Address></a:EndpointReference><d:Types>wsdp:Device wscn:ScanDeviceType</d:Types><d:XAddrs>http://10.0.0.5:3911/ http://[fe80::1]:3911/</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>"#;
        let ep = parse_probe_match(pm).unwrap();
        assert_eq!(ep.epr, "urn:uuid:abc");
        assert_eq!(pick_address(&ep.xaddrs, "10.0.0.5").unwrap(), "http://10.0.0.5:3911/");
        let meta = r#"<x xmlns:p="http://schemas.xmlsoap.org/ws/2006/02/devprof" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"><p:Hosted><a:EndpointReference><a:Address>http://10.0.0.5:3910/</a:Address></a:EndpointReference><p:Types>wprt:PrinterServiceType</p:Types></p:Hosted><p:Hosted><a:EndpointReference><a:Address>http://10.0.0.5:53048/</a:Address></a:EndpointReference><p:Types>wscn:ScannerServiceType</p:Types></p:Hosted></x>"#;
        assert_eq!(parse_scanner_service(meta), vec!["http://10.0.0.5:53048/"]);
    }

    #[test]
    fn extracts_mtom_image_part() {
        let body = b"--uuid:b1\r\nContent-Type: application/xop+xml; type=\"application/soap+xml\"\r\n\r\n<soap/>\r\n--uuid:b1\r\nContent-Type: application/binary\r\nContent-ID: <img>\r\n\r\n\x89PNGDATA\r\n--uuid:b1--\r\n";
        let img = mtom_image(r#"multipart/related; type="application/xop+xml"; boundary="uuid:b1""#, body).unwrap();
        assert_eq!(img, b"\x89PNGDATA");
        assert!(mtom_image("application/soap+xml", b"<x/>").is_none());
    }

    #[test]
    fn reads_fault_subcode() {
        let f = r#"<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="x"><e:Body><e:Fault><e:Code><e:Value>e:Sender</e:Value><e:Subcode><e:Value>w:ClientErrorNoImagesAvailable</e:Value></e:Subcode></e:Code></e:Fault></e:Body></e:Envelope>"#;
        assert_eq!(fault_code(f).as_deref(), Some("ClientErrorNoImagesAvailable"));
    }
}

#[cfg(test)]
mod live {
    #[tokio::test]
    #[ignore]
    async fn live_locate() {
        let host = std::env::var("PAPERDOCK_HOST").unwrap();
        let t = std::time::Instant::now();
        let ep = tokio::task::spawn_blocking({ let h = host.clone(); move || super::probe(&h) }).await.unwrap();
        println!("probe {:?} in {:?}", ep, t.elapsed());
        let ws = super::WsScanner::locate(&host).await;
        println!("locate {:?} in {:?}", ws.as_ref().map(|w| &w.url).map_err(|e| e.to_string()), t.elapsed());
        let (caps, st, f) = ws.unwrap().elements().await.unwrap();
        println!("{caps:?} {} {f:?}", st.state);
    }
}

#[cfg(test)]
mod live_raw {
    /// Glass scan, saves the device's raw image: `PAPERDOCK_RAW` = output path.
    #[tokio::test]
    #[ignore]
    async fn live_platen_raw() {
        let host = std::env::var("PAPERDOCK_HOST").unwrap();
        let ws = super::WsScanner::locate(&host).await.unwrap();
        let req = crate::escl::ScanRequest {
            source: if std::env::var("PAPERDOCK_SOURCE").as_deref() == Ok("feeder") {
                crate::escl::Source::Feeder
            } else {
                crate::escl::Source::Platen
            },
            color_mode: std::env::var("PAPERDOCK_COLOR").unwrap_or("Grayscale8".into()),
            resolution: 75,
            paper: crate::escl::Paper::A4,
            duplex: false,
        };
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let pages = ws.scan(&req, &cancel, |_| {}).await.unwrap();
        std::fs::write(std::env::var("PAPERDOCK_RAW").unwrap(), &pages[0]).unwrap();
        println!("raw {} bytes, head {:02x?}", pages[0].len(), &pages[0][..16]);
    }
}
