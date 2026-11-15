//! Find printers/scanners on the LAN via mDNS (Bonjour/Avahi compatible).
//!
//! Many devices advertise only some services (e.g. the HP M276n announces
//! `_ipp` but not `_uscan` even though it speaks eSCL), so we browse all of
//! them and merge by host name. Results stream through `on_update`.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;

use crate::error::Result;

const IPP: &str = "_ipp._tcp.local.";
const IPPS: &str = "_ipps._tcp.local.";
const USCAN: &str = "_uscan._tcp.local.";
const USCANS: &str = "_uscans._tcp.local.";
const PDL: &str = "_pdl-datastream._tcp.local.";
const PRINTER: &str = "_printer._tcp.local.";
const SERVICES: &[&str] = &[IPP, IPPS, USCAN, USCANS, PDL, PRINTER];
const REQUERY_EVERY: Duration = Duration::from_millis(2500);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    /// Host name usable as the device address, e.g. `npi1b3aaf.local.`
    pub host: String,
    pub name: String,
    pub addresses: Vec<String>,
    /// Advertised as a scanner (`_uscan`). Devices can still scan without it.
    pub scanner: bool,
    pub printer: bool,
    /// eSCL root from the `rs` TXT record.
    pub escl_root: Option<String>,
    /// IPP resource from the `rp` TXT record.
    pub ipp_resource: Option<String>,
}

/// Blocking browse; run on a worker thread.
pub fn discover(timeout: Duration, mut on_update: impl FnMut(&[Discovered])) -> Result<Vec<Discovered>> {
    let mdns = ServiceDaemon::new()?;
    let mut receivers = Vec::new();
    for s in SERVICES {
        receivers.push((*s, mdns.browse(s)?));
    }

    let mut found: BTreeMap<String, Discovered> = BTreeMap::new();
    let start = Instant::now();
    let deadline = start + timeout;
    // Some devices (e.g. HP M276n) ignore the first queries now and then:
    // restart the browses a few times to send fresh queries.
    let mut requery_at = start + REQUERY_EVERY;
    while Instant::now() < deadline {
        if Instant::now() >= requery_at && found.len() < 64 {
            requery_at += REQUERY_EVERY;
            for (service, rx) in receivers.iter_mut() {
                let _ = mdns.stop_browse(service);
                if let Ok(new_rx) = mdns.browse(service) {
                    *rx = new_rx;
                }
            }
        }
        let mut changed = false;
        for (service, rx) in &receivers {
            while let Ok(event) = rx.try_recv() {
                let ServiceEvent::ServiceResolved(info) = event else { continue };
                let host = info.get_hostname().to_string();
                let key = host.to_ascii_lowercase();
                let instance = info
                    .get_fullname()
                    .strip_suffix(&format!(".{service}"))
                    .unwrap_or(&host)
                    .replace("\\032", " ");
                let model = info.get_property_val_str("ty").map(str::to_string);
                let entry = found.entry(key).or_insert_with(|| Discovered {
                    host: host.clone(),
                    name: model.clone().unwrap_or_else(|| instance.clone()),
                    addresses: vec![],
                    scanner: false,
                    printer: false,
                    escl_root: None,
                    ipp_resource: None,
                });
                match *service {
                    USCAN | USCANS => {
                        entry.scanner = true;
                        if entry.escl_root.is_none() {
                            entry.escl_root = info.get_property_val_str("rs").map(str::to_string);
                        }
                    }
                    IPP | IPPS => {
                        entry.printer = true;
                        if entry.ipp_resource.is_none() {
                            entry.ipp_resource = info.get_property_val_str("rp").map(str::to_string);
                        }
                        // Instance names from IPP are the most descriptive.
                        entry.name = instance;
                    }
                    _ => entry.printer = true,
                }
                for a in info.get_addresses() {
                    let a = a.to_string();
                    if !entry.addresses.contains(&a) {
                        entry.addresses.push(a);
                        // Prefer IPv4 first for display.
                        entry.addresses.sort_by_key(|a| a.contains(':'));
                    }
                }
                changed = true;
            }
        }
        if changed {
            let list: Vec<_> = found.values().cloned().collect();
            on_update(&list);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = mdns.shutdown();
    Ok(found.into_values().collect())
}
