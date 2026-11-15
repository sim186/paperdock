//! eSCL (AirScan) client. This printer speaks the 2011 HP draft of the
//! protocol: JPEG output only, geometry in 1/300 inch.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use roxmltree::Document;
use serde::{Deserialize, Serialize};

use crate::client::Printer;
use crate::error::{Error, Result};
use crate::xml::{children, descendants, find, text};

fn caps_path(p: &Printer) -> String {
    format!("{}/ScannerCapabilities", p.escl_root())
}
fn status_path(p: &Printer) -> String {
    format!("{}/ScannerStatus", p.escl_root())
}
fn jobs_path(p: &Printer) -> String {
    format!("{}/ScanJobs", p.escl_root())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InputCaps {
    pub max_width: u32,
    pub max_height: u32,
    pub resolutions: Vec<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScannerCaps {
    pub make_and_model: Option<String>,
    pub namespace: String,
    pub version: String,
    pub color_modes: Vec<String>,
    pub platen: Option<InputCaps>,
    pub adf: Option<InputCaps>,
    /// Feeder can scan both sides in one pass.
    pub adf_duplex: bool,
    pub adf_capacity: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerStatus {
    pub state: String,
    pub adf_state: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
pub enum Source {
    Platen,
    Feeder,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    A4,
    Letter,
    Legal,
    /// Whole scannable area of the chosen source.
    Max,
}

impl Paper {
    /// Size in 1/300 inch.
    fn size(self, caps: &InputCaps) -> (u32, u32) {
        let (w, h) = match self {
            Paper::A4 => (2480, 3508),
            Paper::Letter => (2550, 3300),
            Paper::Legal => (2550, 4200),
            Paper::Max => (caps.max_width, caps.max_height),
        };
        (w.min(caps.max_width), h.min(caps.max_height))
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub source: Source,
    /// eSCL color mode, e.g. RGB24, Grayscale8, BlackAndWhite1.
    pub color_mode: String,
    pub resolution: u32,
    pub paper: Paper,
    /// Hardware duplex (feeder only, when `adf_duplex`).
    #[serde(default)]
    pub duplex: bool,
}

fn parse_input(node: Option<roxmltree::Node>) -> Option<InputCaps> {
    let n = node?;
    let num = |name: &str| text(n, name).and_then(|v| v.parse().ok());
    let mut resolutions: Vec<u32> = descendants(n, "Resolution")
        .filter_map(|r| text(r, "XResolution").and_then(|v| v.parse().ok()))
        .collect();
    resolutions.sort_unstable();
    resolutions.dedup();
    Some(InputCaps {
        max_width: num("MaxWidth")?,
        max_height: num("MaxHeight")?,
        resolutions,
    })
}

pub fn parse_caps(xml: &str) -> Result<ScannerCaps> {
    let doc = Document::parse(xml)?;
    let root = doc.root_element();
    let namespace = root
        .tag_name()
        .namespace()
        .unwrap_or("http://schemas.hp.com/imaging/escl/2011/05/03")
        .to_string();
    let mut color_modes: Vec<String> = descendants(root, "ColorProfile")
        .filter_map(|p| text(p, "ColorReference").or_else(|| text(p, "ColorMode")))
        .collect();
    color_modes.dedup();
    let adf = find(root, "Adf");
    Ok(ScannerCaps {
        make_and_model: text(root, "MakeAndModel"),
        namespace,
        version: children(root, "Version")
            .next()
            .and_then(|v| v.text())
            .unwrap_or("2.0")
            .trim()
            .to_string(),
        color_modes,
        platen: parse_input(find(root, "PlatenInputCaps")),
        adf: parse_input(adf.and_then(|a| find(a, "AdfSimplexInputCaps"))),
        adf_duplex: adf.and_then(|a| find(a, "AdfDuplexInputCaps")).is_some(),
        adf_capacity: adf.and_then(|a| text(a, "FeederCapacity")).and_then(|v| v.parse().ok()),
    })
}

/// Some old HP firmware exposes a cloud-only eSCL ("CloudScan") whose jobs
/// cannot be fetched: its manifest has no NextDocument resource.
pub async fn usable(p: &Printer) -> bool {
    match p.get_text(&format!("{}/eSclManifest.xml", p.escl_root())).await {
        Ok(m) => m.contains("NextDocument"),
        // No manifest: standard AirScan devices don't publish one.
        Err(_) => true,
    }
}

pub async fn capabilities(p: &Printer) -> Result<ScannerCaps> {
    parse_caps(&p.get_text(&caps_path(p)).await?)
}

pub async fn status(p: &Printer) -> Result<ScannerStatus> {
    let xml = p.get_text(&status_path(p)).await?;
    let doc = Document::parse(&xml)?;
    let r = doc.root_element();
    Ok(ScannerStatus {
        state: text(r, "State").unwrap_or_else(|| "Unknown".into()),
        adf_state: text(r, "AdfState"),
    })
}

pub fn settings_xml(caps: &ScannerCaps, req: &ScanRequest) -> Result<String> {
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
        return Err(Error::invalid_with("unsupported_value", &[("field", "colorMode".into()), ("value", req.color_mode.clone())]));
    }
    if req.duplex && (req.source != Source::Feeder || !caps.adf_duplex) {
        return Err(Error::Unsupported("duplex"));
    }
    let (w, h) = req.paper.size(input);
    let duplex = if req.duplex { "<scan:Duplex>true</scan:Duplex>" } else { "" };
    let source = match req.source {
        Source::Platen => "Platen",
        Source::Feeder => "Feeder",
    };
    Ok(format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<scan:ScanSettings xmlns:scan="{ns}" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">"#,
            "<pwg:Version>{ver}</pwg:Version>",
            "<pwg:ScanRegions><pwg:ScanRegion>",
            // Element order follows the eSCL schema sequence: older HP
            // firmware validates it strictly and answers 400 otherwise.
            "<pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>",
            "<pwg:XOffset>0</pwg:XOffset>",
            "<pwg:YOffset>0</pwg:YOffset>",
            "<pwg:Width>{w}</pwg:Width>",
            "<pwg:Height>{h}</pwg:Height>",
            "</pwg:ScanRegion></pwg:ScanRegions>",
            "<pwg:InputSource>{source}</pwg:InputSource>",
            "{duplex}",
            "<scan:ColorMode>{color}</scan:ColorMode>",
            "<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>",
            "<scan:XResolution>{res}</scan:XResolution>",
            "<scan:YResolution>{res}</scan:YResolution>",
            "</scan:ScanSettings>",
        ),
        ns = caps.namespace,
        ver = caps.version,
        w = w,
        h = h,
        source = source,
        color = crate::xml::escape(&req.color_mode),
        res = req.resolution,
        duplex = duplex,
    ))
}

/// Resolves once `cancel` is set (polled; cheap and runtime-agnostic).
pub async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Run one scan job and return every page as JPEG bytes.
/// `on_page` is called after each page arrives (for progress reporting).
/// Setting `cancel` aborts the job on the device as soon as possible.
pub async fn scan(
    p: &Printer,
    req: &ScanRequest,
    cancel: &AtomicBool,
    mut on_page: impl FnMut(usize),
) -> Result<Vec<Vec<u8>>> {
    let caps = capabilities(p).await?;
    let st = status(p).await?;
    if st.state != "Idle" {
        return Err(Error::invalid_with("scanner_busy", &[("state", st.state.clone())]));
    }
    if req.source == Source::Feeder && st.adf_state.as_deref() == Some("ScannerAdfEmpty") {
        return Err(Error::invalid("adf_empty"));
    }

    let settings = settings_xml(&caps, req)?;
    let job = match p.post_xml(&jobs_path(p), settings.clone()).await {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[escl] scan job rejected; settings sent:\n{settings}");
            return Err(e);
        }
    };
    let location = job
        .location
        .ok_or_else(|| Error::Protocol("scanner did not return a job location".into()))?;
    eprintln!("[escl] job created: {location}");
    let next = format!("{}/NextDocument", location.trim_end_matches('/'));

    let mut pages = Vec::new();
    let mut busy_retries = 0;
    loop {
        let fetched = tokio::select! {
            r = p.get_raw(&next) => Some(r),
            _ = cancelled(cancel) => None,
        };
        let Some(fetched) = fetched else {
            eprintln!("[escl] cancelled by user, deleting job");
            let _ = p.delete(&location).await;
            return Err(Error::invalid("cancelled"));
        };
        let (code, body) = match fetched {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[escl] NextDocument failed: {e}");
                let _ = p.delete(&location).await;
                return Err(e);
            }
        };
        eprintln!("[escl] NextDocument -> {code} ({} bytes)", body.len());
        match code {
            200 => {
                busy_retries = 0;
                pages.push(body);
                on_page(pages.len());
                if req.source == Source::Platen {
                    break;
                }
            }
            // No more pages.
            404 => break,
            // Scanner still warming up / moving paper.
            503 if busy_retries < 60 => {
                busy_retries += 1;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            _ => {
                let _ = p.delete(&location).await;
                return Err(Error::Status { status: code, url: next, detail: String::from_utf8_lossy(&body).chars().take(400).collect() });
            }
        }
    }
    if pages.is_empty() {
        return Err(Error::invalid("no_pages"));
    }
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPS_XML: &str = r#"<scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/02/08" xmlns:pwg2="http://www.pwg.org/schemas/2010/12/sm">
      <pwg2:Version>1.0</pwg2:Version>
      <scan:ColorProfiles>
        <scan:ColorProfile><scan:ColorReference>RGB24</scan:ColorReference></scan:ColorProfile>
        <scan:ColorProfile><scan:ColorReference>Grayscale8</scan:ColorReference></scan:ColorProfile>
      </scan:ColorProfiles>
      <scan:Platen><scan:PlatenInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>3508</scan:MaxHeight>
        <scan:SupportedResolutions>
          <scan:Resolution><scan:XResolution>300</scan:XResolution></scan:Resolution>
          <scan:Resolution><scan:XResolution>75</scan:XResolution></scan:Resolution>
        </scan:SupportedResolutions></scan:PlatenInputCaps></scan:Platen>
      <scan:Adf><scan:AdfSimplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4500</scan:MaxHeight>
        <scan:SupportedResolutions><scan:Resolution><scan:XResolution>200</scan:XResolution></scan:Resolution></scan:SupportedResolutions>
        </scan:AdfSimplexInputCaps><scan:FeederCapacity>50</scan:FeederCapacity></scan:Adf>
    </scan:ScannerCapabilities>"#;

    #[test]
    fn parses_device_capabilities() {
        let c = parse_caps(CAPS_XML).unwrap();
        assert_eq!(c.namespace, "http://schemas.hp.com/imaging/escl/2011/02/08");
        assert_eq!(c.version, "1.0");
        assert_eq!(c.color_modes, vec!["RGB24", "Grayscale8"]);
        assert_eq!(c.platen.as_ref().unwrap().resolutions, vec![75, 300]);
        assert_eq!(c.adf.as_ref().unwrap().max_height, 4500);
        assert_eq!(c.adf_capacity, Some(50));
    }

    #[test]
    fn builds_settings_and_clamps_paper() {
        let c = parse_caps(CAPS_XML).unwrap();
        let req = ScanRequest {
            source: Source::Platen,
            color_mode: "RGB24".into(),
            resolution: 300,
            paper: Paper::Legal,
            duplex: false,
        };
        let xml = settings_xml(&c, &req).unwrap();
        assert!(xml.contains("<pwg:Height>3508</pwg:Height>"), "legal clamped to platen");
        assert!(xml.contains("<pwg:InputSource>Platen</pwg:InputSource>"));
        let doc = roxmltree::Document::parse(&xml).unwrap();
        // Schema order matters for strict firmware.
        let region: Vec<&str> = descendants(doc.root_element(), "ScanRegion")
            .next()
            .unwrap()
            .children()
            .filter(|n| n.is_element())
            .map(|n| n.tag_name().name())
            .collect();
        assert_eq!(region, ["ContentRegionUnits", "XOffset", "YOffset", "Width", "Height"]);
        let top: Vec<&str> = doc
            .root_element()
            .children()
            .filter(|n| n.is_element())
            .map(|n| n.tag_name().name())
            .collect();
        assert_eq!(
            top,
            ["Version", "ScanRegions", "InputSource", "ColorMode", "DocumentFormat", "XResolution", "YResolution"]
        );
    }

    #[test]
    fn rejects_unsupported_settings() {
        let c = parse_caps(CAPS_XML).unwrap();
        let mut req = ScanRequest {
            source: Source::Feeder,
            color_mode: "RGB24".into(),
            resolution: 300,
            paper: Paper::A4,
            duplex: false,
        };
        assert!(settings_xml(&c, &req).is_err(), "ADF lacks 300 dpi");
        req.resolution = 200;
        req.color_mode = "CMYK".into();
        assert!(settings_xml(&c, &req).is_err());
        req.color_mode = "RGB24".into();
        req.duplex = true;
        assert!(settings_xml(&c, &req).is_err(), "no duplex unit");
        assert!(!c.adf_duplex);
    }
}
