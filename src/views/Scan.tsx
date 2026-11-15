import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api,
  AppError,
  BatchMode,
  Device,
  Paper,
  ScanFinished,
  ScanProgress,
  ScanRequest,
  ScannerStatus,
  SessionView,
  Source,
  toAppError,
} from "../api";
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Icon,
  IconButton,
  LinearProgress,
  PageHeader,
  Segmented,
  SelectField,
  Switch,
} from "../components";
import { useSnackbar } from "../snackbar";
import { pickFiles, useFileDrop, useLoad } from "../hooks";
import type { SourceDoc } from "../printing";
import { ACCEPT } from "../files";
// pdf.js and pdf-lib are big: load them only when a file is imported or printed.
const printing = () => import("../printing");
import { useHas, useI18n } from "../i18n";
import PageViewer from "./PageViewer";
import { useActivity } from "../activity";
import { storageGet, storageSet } from "../storage";

type Sides = "simplex" | "auto" | "manual";
type Format = "pdf" | "jpeg";

interface Prefs {
  source: Source;
  sides: Sides;
  colorMode: string;
  resolution: number;
  paper: Paper;
  skipBlank: boolean;
  reverseBacks: boolean;
  format: Format;
}

const DEFAULTS: Prefs = {
  source: "Feeder",
  sides: "simplex",
  colorMode: "RGB24",
  resolution: 300,
  paper: "a4",
  skipBlank: true,
  reverseBacks: true,
  format: "pdf",
};

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(storageGet("scanPrefs") ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

function timestamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Pages imported from files are rendered at this resolution. */
const IMPORT_DPI = 200;

export default function ScanView({
  device,
  active,
  onPrint,
}: {
  device: Device;
  /** The screen is visible (it stays mounted while hidden). */
  active: boolean;
  onPrint?: (doc: SourceDoc) => void;
}) {
  const { t } = useI18n();
  const has = useHas();
  const snack = useSnackbar();
  const info = useLoad(() => api.scannerInfo(device), [device]);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [session, setSession] = useState<SessionView>({ pages: [], awaitingBacks: null });
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preparingPrint, setPreparingPrint] = useState(false);
  /** Index of the page open in the viewer. */
  const [viewing, setViewing] = useState<number | null>(null);
  const closeViewer = useCallback(() => setViewing(null), []);

  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      storageSet("scanPrefs", JSON.stringify(next));
      return next;
    });

  /** This screen started the running scan (else it was found running). */
  const ownScan = useRef(false);

  // The backend owns the scan: pick up one that is already running (the
  // window was reloaded, or the device was switched back), and follow its
  // progress and end through events.
  useEffect(() => {
    api.session().then(setSession).catch(() => {});
    api
      .scanStatus()
      .then((p) => {
        if (p && !ownScan.current) {
          setBusy(true);
          setProgress(p);
        }
      })
      .catch(() => {});
    const unProgress = listen<ScanProgress>("scan-progress", (e) => setProgress(e.payload));
    const unFinished = listen<ScanFinished>("scan-finished", (e) => {
      if (ownScan.current) return; // run() handles its own result
      setBusy(false);
      setProgress(null);
      if (e.payload.session) setSession(e.payload.session);
      if (e.payload.error && e.payload.error.code !== "cancelled") setError(e.payload.error);
    });
    return () => {
      unProgress.then((f) => f());
      unFinished.then((f) => f());
    };
  }, []);

  // Safety net for a scan found running: if its end event was missed (it can
  // fire before the listener is in place), notice the end by polling.
  useEffect(() => {
    if (!busy || ownScan.current) return;
    const id = window.setInterval(async () => {
      if (ownScan.current) return;
      const p = await api.scanStatus().catch(() => null);
      if (p) return;
      setBusy(false);
      setProgress(null);
      api.session().then(setSession).catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [busy]);

  const caps = info.data?.[0];
  const [liveStatus, setLiveStatus] = useState<ScannerStatus | null>(null);
  const polled = liveStatus ?? info.data?.[1];
  // Polling pauses during a scan: don't show a stale "ready".
  const status = busy && polled ? { ...polled, state: "Processing" } : polled;

  // Poll the scanner so loading paper into the feeder enables the button
  // without a manual refresh. Paused while scanning or not on screen.
  useEffect(() => {
    if (busy || !caps || !active) return;
    let stopped = false;
    const tick = () =>
      api
        .scannerStatus(device)
        .then((s) => !stopped && setLiveStatus(s))
        .catch(() => {});
    const id = window.setInterval(tick, 2000);
    tick();
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [busy, caps, device, active]);

  // Keep choices valid for this device.
  const source: Source =
    prefs.source === "Feeder" && !caps?.adf ? "Platen" : prefs.source === "Platen" && !caps?.platen ? "Feeder" : prefs.source;
  const input = source === "Platen" ? caps?.platen : caps?.adf;
  const resolutions = input?.resolutions ?? [];
  const resolution = resolutions.includes(prefs.resolution)
    ? prefs.resolution
    : resolutions.find((r) => r >= 300) ?? resolutions[resolutions.length - 1] ?? prefs.resolution;
  const colorMode = caps?.colorModes.includes(prefs.colorMode) ? prefs.colorMode : caps?.colorModes[0] ?? "RGB24";
  let sides: Sides = source === "Feeder" ? prefs.sides : "simplex";
  if (sides === "auto" && !caps?.adfDuplex) sides = "manual";

  const adfEmpty = status?.adfState === "ScannerAdfEmpty";
  const awaitingBacks = session.awaitingBacks;
  const pages = session.pages;
  const blankCount = pages.filter((p) => p.blank).length;
  const locked = busy || awaitingBacks !== null;

  useActivity(
    "scan",
    busy
      ? {
          tab: "scan",
          icon: "document_scanner",
          label: t("scan.scanning"),
          detail:
            progress?.phase === "processing"
              ? t("scan.processing", { n: progress.pages })
              : progress?.pages
                ? t("scan.pageN", { n: progress.pages })
                : undefined,
        }
      : awaitingBacks !== null
        ? { tab: "scan", icon: "flip", label: t("scan.flipTitle"), detail: t("scan.flipStep"), needsYou: true }
        : importing
          ? { tab: "scan", icon: "upload_file", label: t("scan.importing") }
          : null,
  );

  async function run(mode: BatchMode) {
    ownScan.current = true;
    setBusy(true);
    setError(null);
    setProgress(null);
    const request: ScanRequest = { source, colorMode, resolution, paper: prefs.paper, duplex: sides === "auto" };
    try {
      const next = await api.scan(device, request, mode, prefs.reverseBacks, prefs.skipBlank);
      setSession(next);
      const skipped = next.skippedBlank ?? 0;
      if (skipped > 0) {
        snack(
          next.pages.length === pages.length
            ? t("scan.allBlank", { n: skipped })
            : skipped === 1
              ? t("scan.skippedOne")
              : t("scan.skippedN", { n: skipped }),
          { kind: next.pages.length === pages.length ? "warning" : "info" },
        );
      }
    } catch (e) {
      const err = toAppError(e);
      // A user cancel is not an error worth a red banner.
      if (err.code === "cancelled") snack(t("errors.cancelled"));
      else setError(err);
    } finally {
      ownScan.current = false;
      setBusy(false);
      setProgress(null);
      info.reload();
    }
  }

  async function edit(action: () => Promise<SessionView>) {
    setError(null);
    try {
      setSession(await action());
    } catch (e) {
      setError(toAppError(e));
    }
  }

  const importFiles = useCallback(
    async (files: File[]) => {
      setImporting(true);
      setError(null);
      let added = 0;
      try {
        for (const f of files) {
          const { filePagesAsImages, UnsupportedFile } = await printing();
          let images: Uint8Array[];
          try {
            images = await filePagesAsImages(f, IMPORT_DPI);
          } catch (e) {
            snack(t(e instanceof UnsupportedFile ? "print.unsupportedFile" : "print.readFailed", { name: f.name }), {
              kind: "error",
            });
            continue;
          }
          for (const img of images) {
            setSession(await api.importPage(img, IMPORT_DPI));
            added++;
          }
        }
        if (added) snack(added === 1 ? t("scan.importedOne") : t("scan.imported", { n: added }), { kind: "success" });
      } catch (e) {
        setError(toAppError(e));
      } finally {
        setImporting(false);
      }
    },
    [snack, t],
  );

  const dragging = useFileDrop(importFiles, active && !!caps && !locked && !importing);

  const chooseImport = async () => {
    const files = await pickFiles(ACCEPT);
    if (files.length) importFiles(files);
  };

  async function printDoc() {
    if (!onPrint) return;
    setPreparingPrint(true);
    try {
      const pdf = await api.sessionPdf();
      const { fromBytes } = await printing();
      onPrint(await fromBytes(`${t("scan.fileName")}_${timestamp()}.pdf`, pdf));
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setPreparingPrint(false);
    }
  }

  async function saveDoc() {
    const ext = prefs.format === "pdf" ? "pdf" : "jpg";
    const path = await save({
      defaultPath: `${t("scan.fileName")}_${timestamp()}.${ext}`,
      filters: [{ name: prefs.format.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    setError(null);
    setSaving(true);
    try {
      const files = await api.saveSession(prefs.format, path);
      const names = files.map((f) => f.split(/[\\/]/).pop()).join(", ");
      snack(t("scan.saved", { name: names }), {
        kind: "success",
        action: { label: t("scan.show"), run: () => revealItemInDir(files[0]) },
      });
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setSaving(false);
    }
  }

  const stateLabel = status ? (has(`scan.state.${status.state}`) ? t(`scan.state.${status.state}`) : status.state) : null;
  const ready = status?.state === "Idle";

  const primaryLabel =
    sides === "manual"
      ? pages.length
        ? t("scan.moreFronts")
        : t("scan.startFronts")
      : pages.length && source === "Feeder"
        ? t("scan.more")
        : t("scan.start");

  const canScan = !busy && ready && !(source === "Feeder" && adfEmpty);

  const sourceOptions: { value: Source; label: string; icon: string }[] = [];
  if (caps?.adf) sourceOptions.push({ value: "Feeder", label: t("scan.feeder"), icon: "stacks" });
  if (caps?.platen) sourceOptions.push({ value: "Platen", label: t("scan.glass"), icon: "crop_portrait" });

  return (
    <>
      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-box">
            <Icon name="upload_file" />
            <span className="title-m">{t("scan.dropHere")}</span>
          </div>
        </div>
      )}
      {(info.loading || busy || importing) && (
        <div className="top-progress">
          <LinearProgress label={t("common.loading")} />
        </div>
      )}
      <section className="page wide">
        <PageHeader
          title={t("scan.title")}
          subtitle={
            stateLabel && (
              <div className="row wrap">
                <span className={ready ? "pill ok" : "pill warn"}>
                  <Icon name={ready ? "check" : "hourglass_top"} />
                  {t("scan.scanner", { state: stateLabel })}
                </span>
                {status?.adfState && caps?.adf && (
                  <span className={adfEmpty ? "pill" : "pill ok"}>
                    <Icon name={adfEmpty ? "inbox" : "stacks"} />
                    {adfEmpty ? t("scan.feederEmpty") : t("scan.feederLoaded")}
                  </span>
                )}
              </div>
            )
          }
        >
          {pages.length > 0 && (
            <Button variant="text" icon="note_add" onClick={() => setConfirmNew(true)} disabled={busy || importing}>
              {t("scan.newDoc")}
            </Button>
          )}
          <IconButton icon="refresh" label={t("common.refresh")} onClick={info.reload} disabled={busy} />
        </PageHeader>

        <ErrorBanner error={info.error ?? error} onRetry={info.error ? info.reload : undefined} />

        {caps && (
          <div className="scan-layout">
            <div className="card scan-settings">
              {sourceOptions.length > 1 && (
                <div className="seg-field">
                  <span className="seg-label">{t("scan.source")}</span>
                  <Segmented<Source>
                    full
                    label={t("scan.source")}
                    value={source}
                    options={sourceOptions}
                    onChange={(v) => setPrefs({ source: v })}
                    disabled={locked}
                  />
                </div>
              )}

              {source === "Feeder" && (
                <SelectField<Sides>
                  label={t("scan.sides")}
                  value={sides}
                  onChange={(v) => setPrefs({ sides: v })}
                  disabled={locked}
                  hint={sides === "manual" ? t("scan.duplexManualHint") : undefined}
                  options={[
                    { value: "simplex", label: t("scan.simplex") },
                    ...(caps.adfDuplex ? [{ value: "auto" as Sides, label: t("scan.duplexAuto") }] : []),
                    { value: "manual", label: t("scan.duplexManual") },
                  ]}
                />
              )}

              <SelectField
                label={t("scan.color")}
                value={colorMode}
                onChange={(v) => setPrefs({ colorMode: v })}
                disabled={busy}
                options={caps.colorModes.map((c) => ({
                  value: c,
                  label: has(`scan.colorMode.${c}`) ? t(`scan.colorMode.${c}`) : c,
                }))}
              />
              <SelectField<number>
                label={t("scan.resolution")}
                value={resolution}
                onChange={(v) => setPrefs({ resolution: v })}
                disabled={busy}
                options={resolutions.map((r) => ({ value: r, label: `${r} dpi` }))}
              />
              <SelectField<Paper>
                label={t("scan.paper")}
                value={prefs.paper}
                onChange={(v) => setPrefs({ paper: v })}
                disabled={busy}
                options={[
                  { value: "a4", label: "A4" },
                  { value: "letter", label: "Letter" },
                  { value: "legal", label: "Legal" },
                  { value: "max", label: t("scan.paperMax") },
                ]}
              />

              <div className="switches">
                {source === "Feeder" && (
                  <Switch
                    label={t("scan.skipBlank")}
                    checked={prefs.skipBlank}
                    onChange={(v) => setPrefs({ skipBlank: v })}
                    disabled={busy}
                  />
                )}
                {sides === "manual" && (
                  <Switch
                    label={t("scan.reverseBacksShort")}
                    hint={t("scan.reverseBacksHint")}
                    checked={prefs.reverseBacks}
                    onChange={(v) => setPrefs({ reverseBacks: v })}
                    disabled={busy}
                  />
                )}
              </div>
            </div>

            <div className="scan-main">
              {awaitingBacks !== null ? (
                <div className="flip" role="status">
                  <div className="flip-art">
                    <Icon name="flip" />
                  </div>
                  <span className="label-m">{t("scan.flipStep")}</span>
                  <h2 className="title-l">{t("scan.flipTitle")}</h2>
                  <div>
                    <p>{t("scan.flipBody", { n: awaitingBacks })}</p>
                    {adfEmpty && !busy && <p className="flip-note">{t("scan.feederEmptyHint")}</p>}
                    <div className="row wrap">
                      <Button icon="document_scanner" onClick={() => run("backs")} disabled={!canScan}>
                        {t("scan.scanBacks")}
                      </Button>
                      <Button variant="text" onClick={() => edit(() => api.finishFronts(prefs.skipBlank))} disabled={busy}>
                        {t("scan.skipBacks")}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : busy ? (
                <div className="scan-busy" role="status">
                  <div className="row">
                    <Icon name="document_scanner" />
                    <p className="title-m grow">
                      {progress?.phase === "processing"
                        ? t("scan.processing", { n: progress.pages })
                        : progress?.pages
                          ? t("scan.scanningN", { n: progress.pages })
                          : t("scan.scanning")}
                    </p>
                    <Button
                      variant="text"
                      onClick={() => api.cancelScan().catch(() => {})}
                      disabled={progress?.phase === "processing"}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                  <LinearProgress />
                </div>
              ) : (
                <div className="scan-cta">
                  <div className="cta-text">
                    <p className="body-l">
                      {source === "Feeder"
                        ? t("scan.loadFeeder", { n: caps.adfCapacity ?? "?" })
                        : t("scan.loadGlass")}
                    </p>
                    {source === "Feeder" && adfEmpty && (
                      <span className="pill warn">
                        <Icon name="info" />
                        {t("scan.feederEmptyHint")}
                      </span>
                    )}
                    {status && !ready && <span className="pill warn">{t("scan.notReady")}</span>}
                  </div>
                  <Button
                    variant="text"
                    icon="upload_file"
                    onClick={chooseImport}
                    busy={importing}
                    disabled={importing || locked}
                  >
                    {t("scan.importFiles")}
                  </Button>
                  <button
                    type="button"
                    className="fab ripple"
                    onClick={() => run(sides === "manual" ? "fronts" : "append")}
                    disabled={!canScan}
                  >
                    <Icon name={pages.length ? "add" : "document_scanner"} />
                    {primaryLabel}
                  </button>
                </div>
              )}

              {pages.length === 0 ? (
                <div className="pages-empty">
                  <Icon name="description" />
                  <p>{t("scan.empty")}</p>
                </div>
              ) : (
                <ol className="sheets" aria-label={t("scan.pageCount", { n: pages.length })}>
                  {pages.map((p, i) => (
                    <li key={p.id} className={p.blank ? "sheet blank" : "sheet"}>
                      <div className="sheet-paper">
                        <button
                          type="button"
                          className="sheet-open"
                          onClick={() => setViewing(i)}
                          aria-label={t("scan.openPage", { n: i + 1 })}
                          title={t("scan.openPage", { n: i + 1 })}
                        >
                          <img
                            src={p.thumb}
                            alt=""
                            // A sideways page must shrink to stay inside the portrait tile.
                            style={{ transform: `rotate(${p.rotation}deg)${p.rotation % 180 ? " scale(0.7071)" : ""}` }}
                            draggable={false}
                          />
                        </button>
                        <div className="sheet-tools">
                          <IconButton
                            small
                            icon="chevron_left"
                            label={t("scan.moveLeft")}
                            disabled={i === 0 || busy}
                            onClick={() => edit(() => api.movePage(p.id, i - 1))}
                          />
                          <IconButton
                            small
                            icon="rotate_right"
                            label={t("scan.rotate")}
                            disabled={busy}
                            onClick={() => edit(() => api.rotatePage(p.id))}
                          />
                          <IconButton
                            small
                            icon="chevron_right"
                            label={t("scan.moveRight")}
                            disabled={i === pages.length - 1 || busy}
                            onClick={() => edit(() => api.movePage(p.id, i + 1))}
                          />
                          <IconButton
                            small
                            className="delete"
                            icon="delete"
                            label={t("scan.removePage")}
                            disabled={busy}
                            onClick={() => edit(() => api.deletePage(p.id))}
                          />
                        </div>
                      </div>
                      <div className="sheet-meta">
                        <span className="num">{i + 1}</span>
                        {p.blank && <span className="pill">{t("scan.blank")}</span>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              {pages.length > 0 && (
                <div className="doc-bar">
                  <span className="count">
                    {pages.length === 1 ? t("scan.pageCountOne") : t("scan.pageCount", { n: pages.length })}
                  </span>
                  {blankCount > 0 && (
                    <Button variant="text" icon="layers_clear" onClick={() => edit(api.deleteBlank)} disabled={busy}>
                      {t("scan.blankCount", { n: blankCount })}
                    </Button>
                  )}
                  <span className="grow" />
                  {onPrint && (
                    <Button
                      variant="outlined"
                      icon="print"
                      onClick={printDoc}
                      busy={preparingPrint}
                      disabled={busy || preparingPrint || awaitingBacks !== null}
                    >
                      {t("scan.printDoc")}
                    </Button>
                  )}
                  <Segmented<Format>
                    label={t("scan.saveAs")}
                    value={prefs.format}
                    onChange={(v) => setPrefs({ format: v })}
                    options={[
                      { value: "pdf", label: "PDF" },
                      { value: "jpeg", label: "JPEG" },
                    ]}
                  />
                  <Button icon="save" onClick={saveDoc} busy={saving} disabled={busy || saving || awaitingBacks !== null}>
                    {t("scan.saveDoc")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {viewing !== null && (
        <PageViewer
          pages={pages}
          index={Math.min(viewing, pages.length - 1)}
          busy={busy}
          onIndex={setViewing}
          onClose={closeViewer}
          onRotate={(id) => edit(() => api.rotatePage(id))}
          onDelete={(id) => edit(() => api.deletePage(id))}
        />
      )}

      <ConfirmDialog
        open={confirmNew}
        icon="note_add"
        title={t("scan.confirmNewTitle")}
        body={t("scan.confirmNew", { n: pages.length })}
        confirm={t("scan.discard")}
        onClose={() => setConfirmNew(false)}
        onConfirm={() => {
          setConfirmNew(false);
          edit(api.clearSession);
        }}
      />
    </>
  );
}
