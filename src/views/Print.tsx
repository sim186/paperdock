import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, AppError, Device, toAppError } from "../api";
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  LinearProgress,
  PageHeader,
  Segmented,
  SelectField,
  Switch,
} from "../components";
import { SnackHandle, useSnackbar } from "../snackbar";
import { pickFiles, useFileDrop, useLoad } from "../hooks";
import { useI18n } from "../i18n";
import {
  A4,
  ACCEPT,
  compose,
  Composed,
  loadFile,
  Orientation,
  papersFrom,
  parseRange,
  PerSheet,
  Rotation,
  SourceDoc,
  flattenForPrint,
  splitForManualDuplex,
  thumbnails,
  totalPages,
  UnsupportedFile,
} from "../printing";
import { storageGet, storageSet } from "../storage";
import { useActivity } from "../activity";

type Sides = "one-sided" | "two-sided-long-edge" | "two-sided-short-edge" | "manual";
type ColorChoice = "color" | "monochrome";

interface Prefs {
  perSheet: PerSheet;
  orientation: Orientation;
  rotate: Rotation;
  fit: boolean;
  borders: boolean;
  color: ColorChoice;
  sides: Sides;
  reverseBacks: boolean;
  media: string | null;
}

const DEFAULTS: Prefs = {
  perSheet: 1,
  orientation: "auto",
  rotate: 0,
  fit: true,
  borders: false,
  color: "color",
  sides: "one-sided",
  reverseBacks: true,
  media: null,
};

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(storageGet("printPrefs") ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

type Outcome =
  | { kind: "done" | "sent" | "canceled"; id: number | null }
  | { kind: "aborted"; id: number | null; sheets: number };

const PREVIEW_MAX = 24;
const THUMB_W = 150;

export default function PrintView({
  device,
  active,
  deviceName,
  incoming,
  onIncomingTaken,
}: {
  device: Device;
  /** The screen is visible (it stays mounted while hidden). */
  active: boolean;
  deviceName: string;
  /** Documents handed over from another screen (e.g. the scan). */
  incoming: SourceDoc[];
  onIncomingTaken: () => void;
}) {
  const { t } = useI18n();
  const snack = useSnackbar();
  const caps = useLoad(() => api.printCaps(device), [device]);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [docs, setDocs] = useState<SourceDoc[]>([]);
  /** As typed, so the field can be cleared to type a new number. */
  const [copiesText, setCopiesText] = useState("1");
  /** Each page printed this many times in a row (not remembered: it's per document). */
  const [repeat, setRepeat] = useState(1);
  const [rangeMode, setRangeMode] = useState<"all" | "range">("all");
  const [range, setRange] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [composed, setComposed] = useState<Composed | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [phase, setPhase] = useState<"flattening" | "sending" | "printing" | null>(null);
  // Progress snackbar for the job; `report` turns it into the outcome.
  const progressSnack = useRef<SnackHandle | null>(null);
  // Per printer: send pictures instead of the PDF (set by hand, or after the
  // printer threw a PDF away).
  const flattenKey = `printFlatten:${device.host}`;
  const [flatten, setFlattenState] = useState(() => storageGet(flattenKey) === "1");
  const setFlatten = (v: boolean) => {
    setFlattenState(v);
    storageSet(flattenKey, v ? "1" : "0");
  };
  /** Manual duplex: backs waiting for the stack to go back in the tray. */
  const [pendingBacks, setPendingBacks] = useState<{ pdf: Uint8Array; sheets: number } | null>(null);

  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      storageSet("printPrefs", JSON.stringify(next));
      return next;
    });

  // Take documents handed over by other screens.
  useEffect(() => {
    if (!incoming.length) return;
    setDocs((d) => [...d, ...incoming]);
    onIncomingTaken();
  }, [incoming, onIncomingTaken]);

  const addFiles = useCallback(
    async (files: File[]) => {
      setLoadingFiles(true);
      const added: SourceDoc[] = [];
      for (const f of files) {
        try {
          added.push(await loadFile(f));
        } catch (e) {
          snack(t(e instanceof UnsupportedFile ? "print.unsupportedFile" : "print.readFailed", { name: f.name }), {
            kind: "error",
          });
        }
      }
      setDocs((d) => [...d, ...added]);
      setLoadingFiles(false);
    },
    [snack, t],
  );

  const choose = async () => {
    const files = await pickFiles(ACCEPT);
    if (files.length) addFiles(files);
  };

  const dragging = useFileDrop(addFiles, active && !pendingBacks);

  // ---- what the printer offers
  const c = caps.data;
  const papers = useMemo(() => {
    const list = c ? papersFrom(c.media) : [];
    return list.length ? list : [A4];
  }, [c]);
  const paper =
    papers.find((p) => p.media === prefs.media) ??
    papers.find((p) => p.media === c?.mediaDefault) ??
    papers.find((p) => p.label === "A4") ??
    papers[0];
  const canMono = !!c && c.color && c.colorModes.includes("monochrome");
  const color: ColorChoice = c && !c.color ? "monochrome" : canMono ? prefs.color : "color";
  const sideOptions: { value: Sides; label: string }[] = [{ value: "one-sided", label: t("print.oneSided") }];
  if (c?.sides.includes("two-sided-long-edge")) sideOptions.push({ value: "two-sided-long-edge", label: t("print.longEdge") });
  if (c?.sides.includes("two-sided-short-edge"))
    sideOptions.push({ value: "two-sided-short-edge", label: t("print.shortEdge") });
  sideOptions.push({ value: "manual", label: t("print.manualDuplex") });
  const sides: Sides = sideOptions.some((o) => o.value === prefs.sides) ? prefs.sides : "one-sided";

  // ---- selection
  const total = totalPages(docs);
  const rangeText = rangeMode === "range" ? range : "";
  const picked = parseRange(rangeText, total);
  const rangeError = rangeMode === "range" && range.trim() !== "" && !picked;

  // ---- compose + preview (debounced)
  const layoutKey = JSON.stringify([docs.map((d) => d.id), rangeText, repeat, prefs, paper.media]);
  const job = useRef(0);
  useEffect(() => {
    if (!docs.length || !picked) {
      setComposed(null);
      setThumbs([]);
      return;
    }
    const id = ++job.current;
    setPreviewBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const out = await compose(docs, {
          range: rangeText,
          repeat,
          perSheet: prefs.perSheet,
          orientation: prefs.orientation,
          rotate: prefs.rotate,
          fit: prefs.fit,
          borders: prefs.borders,
          paper,
        });
        if (id !== job.current) return;
        setComposed(out);
        const urls = await thumbnails(out.pdf, THUMB_W, PREVIEW_MAX);
        if (id !== job.current) {
          urls.forEach(URL.revokeObjectURL);
          return;
        }
        setThumbs(urls); // the effect below frees the previous ones
        setError(null);
      } catch (e) {
        if (id === job.current) setError(toAppError(e));
      } finally {
        if (id === job.current) setPreviewBusy(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Free each set of preview images once it's replaced or the screen closes.
  useEffect(() => () => thumbs.forEach(URL.revokeObjectURL), [thumbs]);

  // ---- printing
  const resource = c?.resource ?? device.hints.ippResource ?? "ipp/print";
  const jobName = docs.length === 1 ? docs[0].name : t("print.jobName");
  // Only send what differs from the printer's defaults: some (e.g. HP M276n)
  // abort the whole job over a `media` they don't like. The paper size is
  // already in the PDF's page size.
  const baseOptions = {
    jobName,
    colorMode: canMono && color === "monochrome" ? "monochrome" : undefined,
  };

  /**
   * Send a PDF and follow the job on the printer until it ends. A printer
   * that throws the PDF away without printing (old firmware vs. modern PDF
   * features) gets it again as pictures, and keeps getting pictures.
   */
  async function send(pdf: Uint8Array, opts: { copies?: number; sides?: string }): Promise<Outcome> {
    const attempt = async (asImages: boolean) => {
      setPhase(asImages ? "flattening" : "sending");
      const data = asImages ? await flattenForPrint(pdf) : pdf;
      setPhase("sending");
      const id = await api.print(device, resource, data, { ...baseOptions, ...opts });
      setPhase("printing");
      return follow(id);
    };
    let outcome = await attempt(flatten);
    if (outcome.kind === "aborted" && !outcome.sheets && !flatten) {
      setFlatten(true);
      snack(t("print.retryFlat"), { kind: "warning" });
      outcome = await attempt(true);
    }
    return outcome;
  }

  /** Poll the job until it ends; long jobs stop being followed after a while. */
  async function follow(id: number | null): Promise<Outcome> {
    if (id === null) return { kind: "sent", id };
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await api.printJobStatus(device, resource, id).catch(() => null);
      if (!st) continue;
      if (st.state === 9) return { kind: "done", id };
      if (st.state === 8) return { kind: "aborted", id, sheets: st.sheets ?? 0 };
      if (st.state === 7) return { kind: "canceled", id };
    }
    return { kind: "sent", id };
  }

  function report(o: Outcome) {
    progressSnack.current = null;
    if (o.kind === "done") snack(t("print.done"), { kind: "success", key: "print" });
    else if (o.kind === "sent") snack(o.id ? t("print.sentJob", { id: o.id }) : t("print.sent"), { kind: "success", key: "print" });
    else if (o.kind === "canceled") snack(t("print.canceled"), { kind: "warning", key: "print" });
    else {
      snack(t("print.aborted"), { kind: "error", key: "print" });
      setError({ code: "print_aborted", message: `job ${o.id} aborted`, params: {} });
    }
  }

  async function print() {
    if (!composed) return;
    setSending(true);
    setError(null);
    try {
      if (sides === "manual") {
        const split = await splitForManualDuplex(composed.pdf, copies, prefs.reverseBacks);
        const o = await send(split.fronts, {});
        // Only ask to flip the stack once the fronts are really on paper.
        if (o.kind === "done" || o.kind === "sent") setPendingBacks({ pdf: split.backs, sheets: split.sheets });
        else report(o);
      } else {
        report(await send(composed.pdf, { copies, sides: sides === "one-sided" ? undefined : sides }));
      }
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setSending(false);
      setPhase(null);
    }
  }

  async function printBacks() {
    if (!pendingBacks) return;
    setSending(true);
    setError(null);
    try {
      const o = await send(pendingBacks.pdf, {});
      setPendingBacks(null);
      report(o);
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setSending(false);
      setPhase(null);
    }
  }

  const move = (i: number, to: number) =>
    setDocs((d) => {
      const next = [...d];
      const [x] = next.splice(i, 1);
      next.splice(to, 0, x);
      return next;
    });

  const sheets = composed?.sheets ?? 0;
  const sheetsLabel = sides === "one-sided" ? sheets : Math.ceil(sheets / 2);
  const copies = Math.max(1, Math.min(c?.copiesMax ?? 999, Math.floor(Number(copiesText)) || 1));
  const pagesText = (n: number) => (n === 1 ? t("print.pagesOne") : t("print.pagesN", { n }));
  const sheetsText = (n: number) => (n === 1 ? t("print.sheetsOne") : t("print.sheetsN", { n }));
  const locked = sending || !!pendingBacks;

  // Show where the job is while it runs, whichever control started it.
  useEffect(() => {
    if (!sending || !phase) return;
    const label =
      phase === "printing" ? t("print.onPrinter") : phase === "flattening" ? t("print.flattening") : t("print.printing");
    progressSnack.current = snack(`${label} · ${jobName}`, { kind: "progress", key: "print" });
  }, [sending, phase, jobName, snack, t]);
  useEffect(() => {
    // Ended without an outcome (an error, shown in the banner): drop the progress.
    if (!sending && progressSnack.current) {
      progressSnack.current.dismiss();
      progressSnack.current = null;
    }
  }, [sending]);

  useActivity(
    "print",
    sending
      ? {
          tab: "print",
          icon: "print",
          label:
            phase === "printing"
              ? t("print.onPrinter")
              : phase === "flattening"
                ? t("print.flattening")
                : t("print.printing"),
          detail: jobName,
        }
      : pendingBacks
        ? { tab: "print", icon: "flip", label: t("print.flipTitle"), detail: t("print.flipStep"), needsYou: true }
        : loadingFiles
          ? { tab: "print", icon: "upload_file", label: t("print.addFiles") }
          : null,
  );

  if (c && !c.pdf) {
    return (
      <section className="page">
        <PageHeader title={t("print.title")} />
        <EmptyState icon="print_disabled" title={t("print.title")} body={t("print.noPdf")} />
      </section>
    );
  }

  return (
    <>
      {(caps.loading || loadingFiles || sending) && (
        <div className="top-progress">
          <LinearProgress label={t("common.loading")} />
        </div>
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-box">
            <Icon name="upload_file" />
            <span className="title-m">{t("print.dropHere")}</span>
          </div>
        </div>
      )}
      <section className="page wide">
        <PageHeader title={t("print.title")} subtitle={t("print.subtitle", { name: deviceName })}>
          {docs.length > 0 && (
            <Button variant="outlined" icon="note_add" onClick={choose} disabled={locked || loadingFiles}>
              {t("print.addFiles")}
            </Button>
          )}
        </PageHeader>

        <ErrorBanner error={caps.error ?? error} onRetry={caps.error ? caps.reload : undefined} />

        <div className="scan-layout">
          <div className="card scan-settings">
            <Field label={t("print.copies")} disabled={locked}>
              <input
                type="number"
                min={1}
                max={c?.copiesMax ?? 999}
                value={copiesText}
                disabled={locked}
                onChange={(e) => setCopiesText(e.target.value)}
                onBlur={() => setCopiesText(String(copies))}
              />
            </Field>

            <div className="seg-field">
              <span className="seg-label">{t("print.pages")}</span>
              <Segmented<"all" | "range">
                full
                label={t("print.pages")}
                value={rangeMode}
                onChange={setRangeMode}
                disabled={locked}
                options={[
                  { value: "all", label: t("print.pagesAll") },
                  { value: "range", label: t("print.pagesRange") },
                ]}
              />
            </div>
            {rangeMode === "range" && (
              <Field
                label={t("print.rangeLabel")}
                disabled={locked}
                error={rangeError}
                hint={
                  rangeError
                    ? t("print.rangeInvalid")
                    : picked && total
                      ? t("print.rangeHint", { n: picked.length, total })
                      : undefined
                }
              >
                <input
                  value={range}
                  placeholder={t("print.rangePlaceholder")}
                  spellCheck={false}
                  disabled={locked}
                  autoFocus
                  onChange={(e) => setRange(e.target.value)}
                />
              </Field>
            )}

            <SelectField<number>
              label={t("print.repeat")}
              value={repeat}
              onChange={setRepeat}
              disabled={locked}
              hint={repeat > 1 && repeat !== prefs.perSheet && prefs.perSheet > 1 ? t("print.repeatHint") : undefined}
              options={[1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16].map((n) => ({
                value: n,
                label: n === 1 ? t("print.repeatNone") : t("print.repeatN", { n }),
              }))}
            />
            <SelectField<PerSheet>
              label={t("print.perSheet")}
              value={prefs.perSheet}
              onChange={(v) => setPrefs({ perSheet: v })}
              disabled={locked}
              options={([1, 2, 4, 6, 9, 16] as PerSheet[]).map((n) => ({ value: n, label: String(n) }))}
            />
            <SelectField<Orientation>
              label={t("print.orientation")}
              value={prefs.orientation}
              onChange={(v) => setPrefs({ orientation: v })}
              disabled={locked}
              options={[
                { value: "auto", label: t("print.orientAuto") },
                { value: "portrait", label: t("print.orientPortrait") },
                { value: "landscape", label: t("print.orientLandscape") },
              ]}
            />
            <SelectField<Rotation>
              label={t("print.rotate")}
              value={prefs.rotate}
              onChange={(v) => setPrefs({ rotate: v })}
              disabled={locked}
              options={([0, 90, 180, 270] as Rotation[]).map((n) => ({
                value: n,
                label: n ? t("print.rotateDeg", { n }) : t("print.rotateNone"),
              }))}
            />
            <SelectField<string>
              label={t("print.paper")}
              value={paper.media}
              onChange={(v) => setPrefs({ media: v })}
              disabled={locked}
              options={papers.map((p) => ({ value: p.media, label: p.label }))}
            />
            {(canMono || (c && !c.color)) && (
              <div className="seg-field">
                <span className="seg-label">{t("print.color")}</span>
                <Segmented<ColorChoice>
                  full
                  label={t("print.color")}
                  value={color}
                  onChange={(v) => setPrefs({ color: v })}
                  disabled={locked || !c?.color}
                  options={[
                    { value: "color", label: t("print.colorColor") },
                    { value: "monochrome", label: t("print.colorMono") },
                  ]}
                />
              </div>
            )}
            <SelectField<Sides>
              label={t("print.sides")}
              value={sides}
              onChange={(v) => setPrefs({ sides: v })}
              disabled={locked}
              hint={sides === "manual" ? t("print.manualHint") : undefined}
              options={sideOptions}
            />

            <div className="switches">
              {prefs.perSheet === 1 ? (
                <Switch
                  label={t("print.fit")}
                  hint={prefs.fit ? undefined : t("print.fitHint")}
                  checked={prefs.fit}
                  onChange={(v) => setPrefs({ fit: v })}
                  disabled={locked}
                />
              ) : (
                <Switch
                  label={t("print.borders")}
                  checked={prefs.borders}
                  onChange={(v) => setPrefs({ borders: v })}
                  disabled={locked}
                />
              )}
              <Switch
                label={t("print.flatten")}
                hint={t("print.flattenHint")}
                checked={flatten}
                onChange={setFlatten}
                disabled={locked}
              />
              {sides === "manual" && (
                <Switch
                  label={t("print.reverseBacks")}
                  hint={t("print.reverseBacksHint")}
                  checked={prefs.reverseBacks}
                  onChange={(v) => setPrefs({ reverseBacks: v })}
                  disabled={locked}
                />
              )}
            </div>
          </div>

          <div className="scan-main">
            {pendingBacks && (
              <div className="flip" role="status">
                <div className="flip-art">
                  <Icon name="flip" />
                </div>
                <span className="label-m">{t("print.flipStep")}</span>
                <h2 className="title-l">{t("print.flipTitle")}</h2>
                <div>
                  <p>{t("print.flipBody", { n: pendingBacks.sheets })}</p>
                  <div className="row wrap">
                    <Button icon="print" onClick={printBacks} busy={sending} disabled={sending}>
                      {t("print.printBacks")}
                    </Button>
                    <Button variant="text" onClick={() => setPendingBacks(null)} disabled={sending}>
                      {t("print.cancelBacks")}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {docs.length === 0 ? (
              <div className={dragging ? "drop-zone over" : "drop-zone"}>
                <Icon name="upload_file" />
                <h2 className="title-m">{t("print.dropTitle")}</h2>
                <p>{t("print.dropBody")}</p>
                <Button icon="folder_open" onClick={choose} busy={loadingFiles} disabled={loadingFiles}>
                  {t("print.chooseFiles")}
                </Button>
              </div>
            ) : (
              <>
                <div className="card outlined files-card">
                  <ul className="list">
                    {docs.map((d, i) => (
                      <li key={d.id} className="list-row">
                        <Icon name={d.kind === "pdf" ? "picture_as_pdf" : "image"} className="lead" />
                        <span className="body">
                          <span className="headline" title={d.name}>
                            {d.name}
                          </span>
                          <span className="supporting">{pagesText(d.pages)}</span>
                        </span>
                        <span className="row-actions">
                          <IconButton
                            icon="arrow_upward"
                            label={t("print.moveUp")}
                            disabled={i === 0 || locked}
                            onClick={() => move(i, i - 1)}
                          />
                          <IconButton
                            icon="arrow_downward"
                            label={t("print.moveDown")}
                            disabled={i === docs.length - 1 || locked}
                            onClick={() => move(i, i + 1)}
                          />
                          <IconButton
                            icon="close"
                            label={t("print.remove")}
                            disabled={locked}
                            onClick={() => setDocs((x) => x.filter((y) => y.id !== d.id))}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="row preview-head">
                  <h2 className="title-m grow">{t("print.preview")}</h2>
                  {previewBusy && <span className="body-s muted">{t("print.previewBusy")}</span>}
                </div>
                <ol className={color === "monochrome" ? "sheets print-preview mono" : "sheets print-preview"}>
                  {thumbs.map((u, i) => (
                    <li key={u} className="sheet">
                      <div className="sheet-paper">
                        <img src={u} alt={t("scan.pageN", { n: i + 1 })} draggable={false} />
                      </div>
                      <div className="sheet-meta">
                        <span className="num">{i + 1}</span>
                      </div>
                    </li>
                  ))}
                  {sheets > thumbs.length && thumbs.length > 0 && (
                    <li className="sheet more">
                      <div className="sheet-paper">
                        <span className="title-m">{t("print.previewMore", { n: sheets - thumbs.length })}</span>
                      </div>
                    </li>
                  )}
                </ol>

                <div className="doc-bar">
                  <span className="count">
                    {composed
                      ? t("print.summary", { pages: pagesText(composed.pages), sheets: sheetsText(sheetsLabel * copies) })
                      : "—"}
                  </span>
                  <span className="grow" />
                  <Button variant="text" onClick={() => setDocs([])} disabled={locked}>
                    {t("print.removeAll")}
                  </Button>
                  <Button
                    icon="print"
                    onClick={print}
                    busy={sending}
                    disabled={!composed || !composed.pages || previewBusy || locked || rangeError || !c}
                  >
                    {sending
                      ? phase === "printing"
                        ? t("print.onPrinter")
                        : phase === "flattening"
                          ? t("print.flattening")
                          : t("print.printing")
                      : sides === "manual"
                        ? t("print.printFronts")
                        : t("print.print")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
