import { useEffect, useState } from "react";
import { Alert, api, Device, DeviceProfile, Overview, Supply } from "../api";
import { Button, ErrorBanner, Icon, IconButton, LinearProgress, PageHeader } from "../components";
import { storageGet, storageSet } from "../storage";
import { useSnackbar } from "../snackbar";
import { useLoad } from "../hooks";
import { useHas, useI18n } from "../i18n";

const SUPPLY_COLOR: Record<string, string> = {
  K: "var(--toner-k)",
  C: "var(--toner-c)",
  M: "var(--toner-m)",
  Y: "var(--toner-y)",
  CMY: "linear-gradient(180deg, var(--toner-c) 0 33%, var(--toner-m) 33% 66%, var(--toner-y) 66%)",
};

const FEATURE_ICON: Record<string, string> = {
  ipp: "monitor_heart",
  escl: "document_scanner",
  wsscan: "document_scanner",
  ledm: "settings_remote",
  emailProfiles: "forward_to_inbox",
};

/** After this long without an answer, say what to check instead of only spinning. */
export const SLOW_AFTER_MS = 6000;

interface CachedOverview {
  savedAt: number;
  data: Overview;
}

const cacheKey = (host: string) => `overview:${host}`;

function readCache(host: string): CachedOverview | null {
  try {
    const raw = storageGet(cacheKey(host));
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedOverview;
    return c && typeof c.savedAt === "number" && c.data && Array.isArray(c.data.supplies) ? c : null;
  } catch {
    return null;
  }
}

function timeAgo(ms: number, lang: string, justNow: string) {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return justNow;
  if (min < 60) return rtf.format(-min, "minute");
  const h = Math.round(min / 60);
  if (h < 48) return rtf.format(-h, "hour");
  return rtf.format(-Math.round(h / 24), "day");
}

const LOW_STATES = new Set(["low", "veryLow", "empty", "missing", "incompatible"]);

/** "calibrationRequired" / "media-jam" -> "Calibration required" / "Media jam" */
function humanize(id: string) {
  const words = id.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function severityOf(a: Alert): "error" | "warn" | "info" {
  const s = a.severity ?? "warning";
  if (/error|critical/i.test(s)) return "error";
  if (/warn/i.test(s)) return "warn";
  return "info";
}

function isLow(s: Supply) {
  return (s.level !== null && s.level <= 15) || (!!s.state && LOW_STATES.has(s.state));
}

export default function OverviewView({
  device,
  profile,
  onPickDevice,
}: {
  device: Device;
  profile: DeviceProfile;
  onPickDevice?: () => void;
}) {
  const { t, lang } = useI18n();
  const has = useHas();
  const snack = useSnackbar();
  const { data, error, loading, reload } = useLoad(
    () => api.overview(device, profile.features.ledm),
    [device, profile.features.ledm],
  );
  const [cached] = useState(() => readCache(device.host));
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (data) storageSet(cacheKey(device.host), JSON.stringify({ savedAt: Date.now(), data }));
  }, [data, device.host]);

  useEffect(() => {
    setSlow(false);
    if (!loading) return;
    const id = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [loading]);

  /** Fresh data, or the last known state while the printer has not answered yet. */
  const shown = data ?? cached?.data ?? null;
  const stale = !data && !!cached;

  const stateText = (s: string | null) =>
    s && has(`overview.state.${s}`) ? t(`overview.state.${s}`) : s ?? t("overview.unknownState");

  const features = Object.entries(profile.features).filter(([, on]) => on);

  const alertText = (a: Alert) => {
    if (a.message) return a.message;
    if (!a.id) return "";
    const base = has(`overview.alert.${a.id}`) ? t(`overview.alert.${a.id}`) : humanize(a.id);
    const color = a.color && has(`overview.supply.${colorCode(a.color)}`) ? t(`overview.supply.${colorCode(a.color)}`) : a.color;
    return color ? `${base} (${color.toLowerCase()})` : base;
  };

  const alerts = shown?.alerts ?? [];
  const level: "ok" | "warn" | "error" =
    shown?.state === "stopped" || alerts.some((a) => severityOf(a) === "error")
      ? "error"
      : alerts.some((a) => severityOf(a) === "warn")
        ? "warn"
        : "ok";

  async function copy(part: string) {
    try {
      await navigator.clipboard.writeText(part);
      snack(t("overview.copied", { part }));
    } catch {
      /* clipboard unavailable: nothing to do */
    }
  }

  return (
    <>
      {loading && (
        <div className="top-progress">
          <LinearProgress label={t("common.loading")} />
        </div>
      )}
      <section className="page">
        <PageHeader title={shown?.model ?? profile.model ?? device.name ?? device.host} subtitle={device.host}>
          <IconButton icon="refresh" label={t("common.refresh")} onClick={reload} disabled={loading} />
        </PageHeader>

        <ErrorBanner error={error} onRetry={reload} />

        {loading && slow && (
          <div className="banner info slow-hint" role="status">
            <Icon name="wifi_find" />
            <div className="banner-text">
              <p className="title-s">{t("overview.slowTitle")}</p>
              <p>{t("overview.slowBody")}</p>
            </div>
            {onPickDevice && (
              <Button variant="text" onClick={onPickDevice}>
                {t("devices.chooseOther")}
              </Button>
            )}
          </div>
        )}

        {stale && cached && (
          <p className="stale-note">
            <Icon small name="history" />
            {loading
              ? t("overview.staleLoading", { ago: timeAgo(cached.savedAt, lang, t("overview.justNow")) })
              : t("overview.staleFailed", { ago: timeAgo(cached.savedAt, lang, t("overview.justNow")) })}
          </p>
        )}

        {!shown && loading && <OverviewSkeleton />}

        {shown && (
          <div className={stale ? "overview-body stale" : "overview-body"} aria-busy={loading}>
            <div className={`status-card ${level}`} role="status">
              <Icon name={level === "ok" ? "check_circle" : level === "warn" ? "warning" : "error"} fill />
              <div className="grow">
                <p className="title-l">{shown.stateMessage ?? stateText(shown.state)}</p>
                {alerts.length > 0 && (
                  <ul>
                    {alerts.map((a, i) => (
                      <li key={`${a.id}-${i}`}>
                        <Icon small name={severityOf(a) === "info" ? "info" : "error"} />
                        {alertText(a)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <h2 className="section-title">{t("overview.supplies")}</h2>
            {shown.supplies.length === 0 ? (
              <p className="muted">{t("overview.noSupplies")}</p>
            ) : (
              <div className="supplies">
                {shown.supplies.map((s, i) => {
                  const name = s.code && has(`overview.supply.${s.code}`) ? t(`overview.supply.${s.code}`) : s.name;
                  const color = (s.code && SUPPLY_COLOR[s.code]) || s.color || "var(--primary)";
                  const low = isLow(s);
                  const pct = Math.max(0, Math.min(100, s.level ?? 0));
                  const stateLabel =
                    s.state && (has(`overview.supplyState.${s.state}`) ? t(`overview.supplyState.${s.state}`) : s.state);
                  return (
                    <div className={low ? "supply low" : "supply"} key={`${s.name}-${i}`}>
                      <div
                        className="cartridge"
                        role="meter"
                        aria-label={name}
                        aria-valuenow={s.level ?? undefined}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div className="cartridge-fill" style={{ height: `${pct}%`, background: color }} />
                      </div>
                      <div className="supply-info">
                        <span className="title-s">{name}</span>
                        <span className="supply-level">
                          {s.level ?? "–"}
                          <small>%</small>
                        </span>
                        {s.estimatedPages ? (
                          <span className="body-s muted">
                            {t("overview.pages", { n: s.estimatedPages.toLocaleString(lang) })}
                          </span>
                        ) : null}
                        {stateLabel && s.state !== "ok" && (
                          <span className={low ? "pill error" : "pill"}>{stateLabel}</span>
                        )}
                      </div>
                      {s.partNumber && (
                        <button
                          type="button"
                          className="chip small has-icon ripple"
                          title={t("overview.copyPart")}
                          onClick={() => copy(s.partNumber!)}
                        >
                          <Icon name="content_copy" />
                          <span className="chip-text">{s.partNumber}</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <h2 className="section-title">{t("overview.device")}</h2>
            <dl className="card outlined facts">
              {shown.productNumber && (
                <div>
                  <dt>{t("overview.productNumber")}</dt>
                  <dd>{shown.productNumber}</dd>
                </div>
              )}
              {shown.serialNumber && (
                <div>
                  <dt>{t("overview.serialNumber")}</dt>
                  <dd>{shown.serialNumber}</dd>
                </div>
              )}
              {shown.firmwareDate && (
                <div>
                  <dt>{t("overview.firmwareDate")}</dt>
                  <dd>{shown.firmwareDate}</dd>
                </div>
              )}
              {shown.location && (
                <div>
                  <dt>{t("overview.location")}</dt>
                  <dd>{shown.location}</dd>
                </div>
              )}
              <div>
                <dt>{t("overview.capabilities")}</dt>
                <dd className="chips">
                  {features.map(([k]) => (
                    <span key={k} className="chip small has-icon">
                      <Icon name={FEATURE_ICON[k] ?? "check"} />
                      {t(`overview.feature.${k}`)}
                    </span>
                  ))}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </section>
    </>
  );
}

/** Shape of the overview while the first answer is on its way: empty cartridges slowly filling. */
function OverviewSkeleton() {
  const { t } = useI18n();
  return (
    <div className="overview-skeleton" aria-hidden>
      <div className="status-card skeleton-card">
        <span className="spinner-dot" />
        <p className="title-m">{t("overview.contacting")}</p>
      </div>
      <h2 className="section-title">{t("overview.supplies")}</h2>
      <div className="supplies">
        {[0, 1, 2, 3].map((i) => (
          <div className="supply" key={i}>
            <div className="cartridge">
              <div className="cartridge-fill skeleton-fill" style={{ animationDelay: `${i * 0.35}s` }} />
            </div>
            <div className="supply-info">
              <span className="skeleton-line" style={{ width: "60%" }} />
              <span className="skeleton-line tall" style={{ width: "45%" }} />
              <span className="skeleton-line" style={{ width: "70%" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function colorCode(color: string) {
  const c = color.toLowerCase();
  if (c.startsWith("black")) return "K";
  if (c.startsWith("cyan")) return "C";
  if (c.startsWith("magenta")) return "M";
  if (c.startsWith("yellow")) return "Y";
  if (c.includes("tri") || c.includes("cmy")) return "CMY";
  return color;
}
