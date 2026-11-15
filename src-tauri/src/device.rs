//! Vendor-neutral view of a device. Each protocol is optional:
//! - IPP  (any network printer): model, state, supply levels
//! - eSCL (AirScan: HP, Canon, Epson, Brother, Xerox, Kyocera, ...): scanning
//! - WS-Scan (Windows WSD scanning, many brands): scanning when eSCL is absent
//! - LEDM (HP only): richer status, scan-to-email profiles

use serde::{Deserialize, Serialize};

use crate::client::Printer;
use crate::error::{Error, Result};
use crate::wsscan::WsScanner;
use crate::{escl, ipp, ledm};

/// Hints from discovery that speed up probing.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hints {
    pub escl_root: Option<String>,
    pub ipp_resource: Option<String>,
    /// Scan protocol chosen by `probe`: "escl" or "wsscan".
    pub scan_protocol: Option<String>,
    /// WS-Scan service URL found by `probe` (its port changes on reboot).
    pub wsscan_url: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub ipp: bool,
    pub escl: bool,
    pub wsscan: bool,
    pub ledm: bool,
    /// LEDM email service present (scan-to-email profiles).
    pub email_profiles: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfile {
    pub model: Option<String>,
    pub features: Features,
    /// "escl" | "wsscan" | null
    pub scan_protocol: Option<String>,
    pub wsscan_url: Option<String>,
}

pub fn printer(host: &str, hints: &Hints) -> Result<Printer> {
    Ok(Printer::new(host)?.with_escl_root(hints.escl_root.as_deref()))
}

pub async fn probe(host: &str, hints: &Hints) -> Result<DeviceProfile> {
    let p = printer(host, hints)?;
    let host_name = p.host_name();
    let escl_check = async {
        let caps = escl::capabilities(&p).await?;
        // A caps document alone isn't enough: cloud-only eSCL can't deliver pages.
        if escl::usable(&p).await {
            Ok(caps)
        } else {
            Err(Error::Unsupported("escl"))
        }
    };
    let (ipp_res, escl_res, ledm_res, ws_res) = tokio::join!(
        ipp::printer_info(&host_name, hints.ipp_resource.as_deref()),
        escl_check,
        p.get_text("/DevMgmt/DiscoveryTree.xml"),
        WsScanner::locate(&host_name),
    );
    // A printer waking from sleep often misses the first IPP request while
    // its web server already answers: ask once more before giving up.
    let ipp_res = match ipp_res {
        Err(e) if !matches!(&e, Error::Http(h) if h.is_connect()) => {
            eprintln!("[probe] IPP failed ({e}), retrying");
            ipp::printer_info(&host_name, hints.ipp_resource.as_deref()).await
        }
        r => r,
    };
    let ledm_tree = ledm_res.ok().filter(|x| x.contains("DiscoveryTree"));
    let email_profiles = ledm_tree
        .as_deref()
        .map(|t| t.contains("EmailServiceManifest"))
        .unwrap_or(false);
    let model = ipp_res
        .as_ref()
        .ok()
        .and_then(|i| i.make_and_model.clone())
        .or_else(|| escl_res.as_ref().ok().and_then(|c| c.make_and_model.clone()));
    let features = Features {
        ipp: ipp_res.is_ok(),
        escl: escl_res.is_ok(),
        wsscan: ws_res.is_ok(),
        ledm: ledm_tree.is_some(),
        email_profiles,
    };
    let scan_protocol = if features.escl {
        Some("escl".to_string())
    } else if features.wsscan {
        Some("wsscan".to_string())
    } else {
        None
    };
    let wsscan_url = ws_res.as_ref().ok().map(|w| w.url.clone());
    eprintln!("[probe] {host}: {features:?} scan={scan_protocol:?} ws={wsscan_url:?}");
    if !features.ipp && !features.escl && !features.wsscan && !features.ledm {
        // Surface the most useful error (usually unreachable host).
        return Err(match (ipp_res, escl_res) {
            (Err(e @ Error::Http(_)), _) | (_, Err(e @ Error::Http(_))) => e,
            _ => Error::Unsupported("device"),
        });
    }
    Ok(DeviceProfile { model, features, scan_protocol, wsscan_url })
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Supply {
    pub name: String,
    /// Short code when known (K, C, M, Y) for coloring/translation.
    pub code: Option<String>,
    pub color: Option<String>,
    pub level: Option<u8>,
    pub part_number: Option<String>,
    pub estimated_pages: Option<u32>,
    pub state: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub model: Option<String>,
    /// idle | processing | stopped | vendor specific
    pub state: Option<String>,
    pub state_message: Option<String>,
    pub alerts: Vec<ledm::Alert>,
    pub supplies: Vec<Supply>,
    pub serial_number: Option<String>,
    pub product_number: Option<String>,
    pub firmware_date: Option<String>,
    pub location: Option<String>,
    pub color: Option<bool>,
    pub duplex_print: Option<bool>,
}

fn code_for(name: &str, color: Option<&str>) -> Option<String> {
    let n = name.to_ascii_lowercase();
    let c = color.map(|c| c.to_ascii_uppercase());
    let code = if n.contains("black") || c.as_deref() == Some("#000000") {
        "K"
    } else if n.contains("cyan") || c.as_deref() == Some("#00FFFF") {
        "C"
    } else if n.contains("magenta") || c.as_deref() == Some("#FF00FF") {
        "M"
    } else if n.contains("yellow") || c.as_deref() == Some("#FFFF00") {
        "Y"
    } else {
        return None;
    };
    Some(code.into())
}

pub async fn overview(host: &str, hints: &Hints, features_ledm: bool) -> Result<Overview> {
    let p = printer(host, hints)?;
    let host_name = p.host_name();
    let ipp_fut = ipp::printer_info(&host_name, hints.ipp_resource.as_deref());
    let ledm_fut = async {
        if features_ledm {
            Some(ledm::overview(&p).await)
        } else {
            None
        }
    };
    let (ipp_res, ledm_res) = tokio::join!(ipp_fut, ledm_fut);

    let mut out = Overview::default();
    let mut any = false;

    if let Ok(i) = &ipp_res {
        any = true;
        out.model = i.make_and_model.clone();
        out.state = i.state.clone();
        out.state_message = i.state_message.clone();
        out.alerts = i
            .state_reasons
            .iter()
            .map(|r| ledm::Alert {
                // IPP reasons end in -report/-warning/-error.
                id: Some(
                    r.trim_end_matches("-report")
                        .trim_end_matches("-warning")
                        .trim_end_matches("-error")
                        .to_string(),
                ),
                message: None,
                severity: r.rsplit('-').next().map(str::to_string),
                color: None,
            })
            .collect();
        out.location = i.location.clone();
        out.color = Some(i.color);
        out.duplex_print = Some(i.duplex);
        out.supplies = i
            .markers
            .iter()
            .map(|m| Supply {
                code: code_for(&m.name, m.color.as_deref()),
                name: m.name.clone(),
                color: m.color.clone(),
                level: m.level,
                ..Default::default()
            })
            .collect();
    }

    // HP LEDM has localized messages and cartridge numbers: prefer it.
    if let Some(Ok(l)) = ledm_res {
        any = true;
        out.model = out.model.or(l.model);
        out.serial_number = l.serial_number;
        out.product_number = l.product_number;
        out.firmware_date = l.firmware_date;
        if out.state.is_none() {
            out.state = l.status;
        }
        if l.status_message.is_some() {
            out.state_message = l.status_message;
        }
        if !l.alerts.is_empty() {
            out.alerts = l.alerts;
        }
        if !l.consumables.is_empty() {
            let ipp_supplies = std::mem::take(&mut out.supplies);
            out.supplies = l
                .consumables
                .into_iter()
                .map(|c| {
                    let code = Some(c.label.clone()).filter(|l| !l.is_empty());
                    // IPP levels are exact; LEDM rounds to 10% steps on some models.
                    let ipp = ipp_supplies.iter().find(|s| s.code.is_some() && s.code == code);
                    Supply {
                        name: c.name.unwrap_or(c.label),
                        color: ipp.and_then(|s| s.color.clone()),
                        level: ipp.and_then(|s| s.level).or(c.percent),
                        part_number: match (c.selectibility, c.cartridge) {
                            (Some(s), Some(p)) if s != p => Some(format!("{s} ({p})")),
                            (s, p) => s.or(p),
                        },
                        estimated_pages: c.estimated_pages,
                        state: c.state.filter(|s| s != "ok"),
                        code,
                    }
                })
                .collect();
        }
    }

    if !any {
        return Err(ipp_res.err().unwrap_or(Error::Unsupported("status")));
    }

    // Scanner-only devices: at least show the model from eSCL.
    if out.model.is_none() {
        out.model = escl::capabilities(&p).await.ok().and_then(|c| c.make_and_model);
    }
    Ok(out)
}
