mod client;
mod device;
mod discovery;
mod error;
mod escl;
mod ipp;
mod ledm;
mod pdf;
mod session;
mod wsscan;
mod xml;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use client::Printer;
use device::Hints;
use error::{Error, Result};
use session::{Session, SessionView};

#[derive(Default)]
struct AppState {
    session: Mutex<Session>,
    scanning: AtomicBool,
    cancel_scan: AtomicBool,
    /// Progress of the running scan, for screens that open while it runs.
    scan_progress: Mutex<Option<ScanProgress>>,
    /// Two concurrent mDNS browsers on one host disturb each other and
    /// miss slow responders, so discoveries run one at a time.
    discovery: std::sync::Arc<Mutex<()>>,
}

/// Lock a mutex even if a panic poisoned it: the data (pages, progress)
/// stays usable, and one failed command shouldn't break every later one.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn blocking_err(e: tauri::Error) -> Error {
    Error::Protocol(e.to_string())
}

/// OS UI language (the webview's navigator.language is unreliable on macOS).
#[tauri::command]
fn system_locale() -> Option<String> {
    sys_locale::get_locale()
}

// ------------------------------------------------------------- devices

#[tauri::command]
async fn discover_printers(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<discovery::Discovered>> {
    let lock = state.discovery.clone();
    let found = tauri::async_runtime::spawn_blocking(move || {
        let _one_at_a_time = lock.lock().unwrap_or_else(|e| e.into_inner());
        discovery::discover(Duration::from_secs(8), |list| {
            let _ = app.emit("discovery-update", list);
        })
    })
    .await
    .map_err(blocking_err)?;
    match &found {
        Ok(list) => eprintln!("[discovery] {} device(s): {:?}", list.len(), list.iter().map(|d| &d.host).collect::<Vec<_>>()),
        Err(e) => eprintln!("[discovery] failed: {e}"),
    }
    found
}

#[tauri::command]
async fn probe_device(host: String, hints: Option<Hints>) -> Result<device::DeviceProfile> {
    device::probe(&host, &hints.unwrap_or_default()).await
}

#[tauri::command]
async fn device_overview(host: String, hints: Option<Hints>, ledm: bool) -> Result<device::Overview> {
    device::overview(&host, &hints.unwrap_or_default(), ledm).await
}

// ------------------------------------------------- HP email profiles

#[tauri::command]
async fn email_accounts(host: String) -> Result<Vec<ledm::EmailAccount>> {
    ledm::list_accounts(&Printer::new(&host)?).await
}

#[tauri::command]
async fn email_account_save(host: String, account: ledm::EmailAccount) -> Result<Option<String>> {
    let p = Printer::new(&host)?;
    match account.id.clone() {
        Some(id) => ledm::update_account(&p, &id, &account).await.map(|_| Some(id)),
        None => ledm::create_account(&p, &account).await,
    }
}

#[tauri::command]
async fn email_account_delete(host: String, id: String) -> Result<()> {
    ledm::delete_account(&Printer::new(&host)?, &id).await
}

#[tauri::command]
async fn email_account_test(host: String, id: String) -> Result<String> {
    ledm::test_account(&Printer::new(&host)?, &id).await
}

#[tauri::command]
async fn scan_to_email_get(host: String) -> Result<ledm::ScanToEmailConfig> {
    ledm::get_scan_to_email(&Printer::new(&host)?).await
}

#[tauri::command]
async fn scan_to_email_set(host: String, settings: ledm::ScanToEmailSettings) -> Result<()> {
    ledm::set_scan_to_email(&Printer::new(&host)?, &settings).await
}

// ------------------------------------------------------------ scanning

/// Scanner reachable via the protocol chosen at probe time.
enum Scanner {
    Escl(Printer),
    Ws(wsscan::WsScanner),
}

async fn scanner(host: &str, hints: &Hints) -> Result<Scanner> {
    if hints.scan_protocol.as_deref() == Some("wsscan") {
        // The cached URL may be stale after a device reboot: re-locate.
        if let Some(url) = &hints.wsscan_url {
            let ws = wsscan::WsScanner::new(url.clone())?;
            if ws.status().await.is_ok() {
                return Ok(Scanner::Ws(ws));
            }
        }
        let p = Printer::new(host)?;
        return Ok(Scanner::Ws(wsscan::WsScanner::locate(&p.host_name()).await?));
    }
    match hints.scan_protocol.as_deref() {
        Some("escl") => Ok(Scanner::Escl(device::printer(host, hints)?)),
        _ => Err(Error::Unsupported("scan")),
    }
}

#[tauri::command]
async fn scanner_info(host: String, hints: Option<Hints>) -> Result<(escl::ScannerCaps, escl::ScannerStatus)> {
    match scanner(&host, &hints.unwrap_or_default()).await? {
        Scanner::Escl(p) => {
            let (caps, status) = tokio::join!(escl::capabilities(&p), escl::status(&p));
            Ok((caps?, status?))
        }
        Scanner::Ws(ws) => {
            let (caps, status, _) = ws.elements().await?;
            Ok((caps, status))
        }
    }
}

/// Cheap status poll (feeder loaded/empty, busy) for the scan screen.
#[tauri::command]
async fn scanner_status(host: String, hints: Option<Hints>) -> Result<escl::ScannerStatus> {
    match scanner(&host, &hints.unwrap_or_default()).await? {
        Scanner::Escl(p) => escl::status(&p).await,
        Scanner::Ws(ws) => ws.status().await,
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum BatchMode {
    /// Append pages (single-sided, or hardware duplex).
    Append,
    /// Manual duplex, first pass: front sides.
    Fronts,
    /// Manual duplex, second pass: back sides of the pending fronts.
    Backs,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    phase: &'static str,
    pages: usize,
}

/// Clears the "scanning" flag and the progress even if the scan fails or panics.
struct ScanGuard<'a>(&'a AppState);
impl Drop for ScanGuard<'_> {
    fn drop(&mut self) {
        *lock(&self.0.scan_progress) = None;
        self.0.scanning.store(false, Ordering::SeqCst);
    }
}

/// Sent as `scan-finished` when a scan ends, whoever started it: the window
/// may have been reloaded or the screen left while the scanner worked.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScanFinished {
    session: Option<SessionView>,
    /// The error as the UI receives it from a command: `{ code, message, params }`.
    error: Option<serde_json::Value>,
}

/// Progress of the running scan, or null when none runs.
#[tauri::command]
fn scan_status(state: State<'_, AppState>) -> Option<ScanProgress> {
    lock(&state.scan_progress).clone()
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn session_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    hints: Option<Hints>,
    request: escl::ScanRequest,
    mode: BatchMode,
    reverse_backs: bool,
    skip_blank: bool,
) -> Result<SessionView> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err(Error::invalid("scan_in_progress"));
    }
    let _guard = ScanGuard(&state);
    state.cancel_scan.store(false, Ordering::SeqCst);
    let report = |p: ScanProgress| {
        *lock(&state.scan_progress) = Some(p.clone());
        let _ = app.emit("scan-progress", p);
    };
    report(ScanProgress { phase: "scanning", pages: 0 });

    let result = run_scan(&state, &report, &host, hints, &request, mode, reverse_backs, skip_blank).await;
    match &result {
        Ok(view) => {
            let _ = app.emit("scan-finished", ScanFinished { session: Some(view.clone()), error: None });
        }
        Err(e) => {
            eprintln!("[scan] failed: {e}");
            let error = serde_json::to_value(e).ok();
            let _ = app.emit("scan-finished", ScanFinished { session: None, error });
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_scan(
    state: &AppState,
    report: &(dyn Fn(ScanProgress) + Sync),
    host: &str,
    hints: Option<Hints>,
    request: &escl::ScanRequest,
    mode: BatchMode,
    reverse_backs: bool,
    skip_blank: bool,
) -> Result<SessionView> {
    let progress = |n| report(ScanProgress { phase: "scanning", pages: n });
    let raw = match scanner(host, &hints.unwrap_or_default()).await? {
        Scanner::Escl(p) => escl::scan(&p, request, &state.cancel_scan, progress).await?,
        Scanner::Ws(ws) => ws.scan(request, &state.cancel_scan, progress).await?,
    };
    eprintln!("[scan] {} page(s), processing", raw.len());

    report(ScanProgress { phase: "processing", pages: raw.len() });
    // Decoding and blank detection are CPU work: keep them off the async runtime.
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        raw.into_iter().map(session::prepare).collect::<Result<Vec<_>>>()
    })
    .await
    .map_err(blocking_err)??;

    // A page on the glass is placed on purpose: never drop it as blank
    // (a light page at low resolution can look empty).
    let skip_blank = skip_blank && request.source != escl::Source::Platen;
    let received = prepared.len();
    let mut s = lock(&state.session);
    let before = s.len();
    match mode {
        BatchMode::Append => s.add_batch(prepared, request.resolution, false, skip_blank),
        BatchMode::Fronts => s.add_batch(prepared, request.resolution, true, skip_blank),
        BatchMode::Backs => s.add_backs(prepared, request.resolution, reverse_backs, skip_blank)?,
    }
    let mut view = s.view();
    view.skipped_blank = (before + received).saturating_sub(s.len());
    if view.skipped_blank > 0 {
        eprintln!("[scan] left out {} blank page(s)", view.skipped_blank);
    }
    Ok(view)
}

#[tauri::command]
fn scan_cancel(state: State<'_, AppState>) {
    state.cancel_scan.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn session_get(state: State<'_, AppState>) -> SessionView {
    lock(&state.session).view()
}

#[tauri::command]
fn session_finish_fronts(state: State<'_, AppState>, skip_blank: bool) -> SessionView {
    let mut s = lock(&state.session);
    s.finish_without_backs(skip_blank);
    s.view()
}

#[tauri::command]
fn session_rotate(state: State<'_, AppState>, id: u64) -> Result<SessionView> {
    let mut s = lock(&state.session);
    s.rotate(id)?;
    Ok(s.view())
}

#[tauri::command]
fn session_delete(state: State<'_, AppState>, id: u64) -> Result<SessionView> {
    let mut s = lock(&state.session);
    s.delete(id)?;
    Ok(s.view())
}

#[tauri::command]
fn session_delete_blank(state: State<'_, AppState>) -> SessionView {
    let mut s = lock(&state.session);
    s.delete_blank();
    s.view()
}

#[tauri::command]
fn session_move(state: State<'_, AppState>, id: u64, to: usize) -> Result<SessionView> {
    let mut s = lock(&state.session);
    s.move_to(id, to)?;
    Ok(s.view())
}

#[tauri::command]
fn session_clear(state: State<'_, AppState>) -> SessionView {
    let mut s = lock(&state.session);
    s.clear();
    s.view()
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Pdf,
    Jpeg,
}

/// Write the session. JPEG with several pages becomes `<stem>-1.jpg`, ...
#[tauri::command]
async fn session_save(state: State<'_, AppState>, format: OutputFormat, path: PathBuf) -> Result<Vec<String>> {
    // Encode under the lock (fast for PDF), write files outside it.
    let output: Vec<(PathBuf, Vec<u8>)> = {
        let s = lock(&state.session);
        if s.is_empty() {
            return Err(Error::invalid("no_pages"));
        }
        match format {
            OutputFormat::Pdf => vec![(path.clone(), s.to_pdf()?)],
            OutputFormat::Jpeg => {
                let pages = s.to_jpegs()?;
                if pages.len() == 1 {
                    vec![(path.clone(), pages.into_iter().next().unwrap())]
                } else {
                    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("scan").to_string();
                    let dir = path.parent().map(PathBuf::from).unwrap_or_default();
                    pages
                        .into_iter()
                        .enumerate()
                        .map(|(i, j)| (dir.join(format!("{stem}-{}.jpg", i + 1)), j))
                        .collect()
                }
            }
        }
    };
    // Disk writes block: keep them off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        for (f, bytes) in output {
            std::fs::write(&f, bytes)?;
            files.push(f.display().to_string());
        }
        Ok(files)
    })
    .await
    .map_err(blocking_err)?
}

/// Add a page from a file. Body: JPEG or PNG bytes; header `x-dpi`.
#[tauri::command]
async fn session_import(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<SessionView> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(Error::invalid("bad_request"));
    };
    let dpi = request
        .headers()
        .get("x-dpi")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .filter(|&d: &u32| (50..=1200).contains(&d))
        .unwrap_or(200);
    let data = data.clone();
    let page = tauri::async_runtime::spawn_blocking(move || session::prepare(data))
        .await
        .map_err(blocking_err)??;
    let mut s = lock(&state.session);
    s.add_imported(page, dpi)?;
    Ok(s.view())
}

/// One scanned page at full size (JPEG bytes), for the page viewer.
#[tauri::command]
fn session_page(state: State<'_, AppState>, id: u64) -> Result<tauri::ipc::Response> {
    let jpeg = lock(&state.session).page_jpeg(id)?;
    Ok(tauri::ipc::Response::new(jpeg))
}

/// The scanned document as PDF bytes (for printing).
#[tauri::command]
fn session_pdf(state: State<'_, AppState>) -> Result<tauri::ipc::Response> {
    let s = lock(&state.session);
    if s.is_empty() {
        return Err(Error::invalid("no_pages"));
    }
    Ok(tauri::ipc::Response::new(s.to_pdf()?))
}

// ------------------------------------------------------------- printing

#[tauri::command]
async fn print_caps(host: String, hints: Option<Hints>) -> Result<ipp::PrintCaps> {
    let p = Printer::new(&host)?;
    ipp::print_caps(&p.host_name(), hints.unwrap_or_default().ipp_resource.as_deref()).await
}

/// Print a PDF. Body: the PDF; headers `x-host`, `x-resource`, `x-options` (JSON).
#[tauri::command]
async fn print_document(request: tauri::ipc::Request<'_>) -> Result<Option<i32>> {
    let tauri::ipc::InvokeBody::Raw(pdf) = request.body() else {
        return Err(Error::invalid("bad_request"));
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let host = header("x-host").ok_or_else(|| Error::invalid("host_empty"))?;
    let resource = header("x-resource").unwrap_or_else(|| "ipp/print".into());
    let opts: ipp::JobOptions = header("x-options")
        .and_then(|o| serde_json::from_str(&o).ok())
        .unwrap_or_default();
    if !pdf.starts_with(b"%PDF") {
        return Err(Error::invalid("bad_request"));
    }
    let p = Printer::new(&host)?;
    eprintln!("[print] {} bytes to {host}/{resource}: {opts:?}", pdf.len());
    ipp::print_pdf(&p.host_name(), &resource, &opts, pdf).await
}

/// State of a print job on the printer.
#[tauri::command]
async fn print_job_status(host: String, resource: String, job_id: i32) -> Result<ipp::JobStatus> {
    let p = Printer::new(&host)?;
    ipp::job_status(&p.host_name(), &resource, job_id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            system_locale,
            discover_printers,
            probe_device,
            device_overview,
            email_accounts,
            email_account_save,
            email_account_delete,
            email_account_test,
            scan_to_email_get,
            scan_to_email_set,
            scanner_info,
            scanner_status,
            session_scan,
            scan_status,
            scan_cancel,
            session_get,
            session_finish_fronts,
            session_rotate,
            session_delete,
            session_delete_blank,
            session_move,
            session_clear,
            session_save,
            session_import,
            session_page,
            session_pdf,
            print_caps,
            print_document,
            print_job_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Read-only checks against a real device:
/// `PAPERDOCK_HOST=192.168.1.84 cargo test live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    fn host() -> String {
        std::env::var("PAPERDOCK_HOST").expect("set PAPERDOCK_HOST")
    }

    #[tokio::test]
    #[ignore]
    async fn live_read_only() {
        let h = host();
        let hints = Hints::default();
        let profile = device::probe(&h, &hints).await.unwrap();
        println!("{}", serde_json::to_string_pretty(&profile).unwrap());
        let o = device::overview(&h, &hints, profile.features.ledm).await.unwrap();
        println!("{}", serde_json::to_string_pretty(&o).unwrap());
        assert!(o.model.is_some());
        println!("IPP: {:?}", ipp::printer_info(&h, None).await);
        let p = Printer::new(&h).unwrap();
        println!("accounts: {:?}", ledm::list_accounts(&p).await);
        println!("caps: {:?}", escl::capabilities(&p).await);
        let pc = ipp::print_caps(&h, None).await.unwrap();
        println!("print caps: {pc:?}");
        assert!(pc.copies_max >= 1);
        for id in [16, 17] {
            println!("job {id}: {:?}", ipp::job_status(&h, &pc.resource, id).await);
        }
    }

    /// PRINTS on paper! `PAPERDOCK_PRINT` = PDF file to send.
    #[tokio::test]
    #[ignore]
    async fn live_print_pdf() {
        let path = std::env::var("PAPERDOCK_PRINT").expect("set PAPERDOCK_PRINT");
        let pdf = std::fs::read(path).unwrap();
        let caps = ipp::print_caps(&host(), None).await.unwrap();
        assert!(caps.pdf, "printer doesn't take PDF");
        let opts = ipp::JobOptions {
            job_name: Some("PaperDock test".into()),
            ..Default::default()
        };
        let job = ipp::print_pdf(&host(), &caps.resource, &opts, &pdf).await.unwrap();
        println!("job id: {job:?}");
    }

    /// Feeds the sheets in the ADF! `PAPERDOCK_OUT` = output PDF path.
    #[tokio::test]
    #[ignore]
    async fn live_scan_feeder() {
        let profile = device::probe(&host(), &Hints::default()).await.unwrap();
        println!("scan protocol: {:?} {:?}", profile.scan_protocol, profile.wsscan_url);
        let hints = Hints {
            scan_protocol: profile.scan_protocol.clone(),
            wsscan_url: profile.wsscan_url.clone(),
            ..Default::default()
        };
        let req = escl::ScanRequest {
            source: escl::Source::Feeder,
            color_mode: "Grayscale8".into(),
            resolution: 75,
            paper: escl::Paper::A4,
            duplex: false,
        };
        let cancel = AtomicBool::new(false);
        let pages = match scanner(&host(), &hints).await.unwrap() {
            Scanner::Escl(p) => escl::scan(&p, &req, &cancel, |n| println!("page {n}")).await.unwrap(),
            Scanner::Ws(ws) => ws.scan(&req, &cancel, |n| println!("page {n}")).await.unwrap(),
        };
        let mut s = Session::default();
        let prepared: Vec<_> = pages.into_iter().map(|j| session::prepare(j).unwrap()).collect();
        s.add_batch(prepared, 75, false, false);
        let out = std::env::var("PAPERDOCK_OUT").unwrap();
        std::fs::write(&out, s.to_pdf().unwrap()).unwrap();
        println!("wrote {out}: {} pages, blank: {:?}", s.view().pages.len(), s.view().pages.iter().map(|p| p.blank).collect::<Vec<_>>());
    }

    #[test]
    #[ignore]
    fn live_discovery() {
        let found = discovery::discover(Duration::from_secs(6), |l| println!("update: {} devices", l.len())).unwrap();
        println!("{found:#?}");
        assert!(!found.is_empty());
    }
}
