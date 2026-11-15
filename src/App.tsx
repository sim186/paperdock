import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AppError, Device, DeviceProfile, Discovered, toAppError } from "./api";
import { Button, Dialog, EmptyState, Icon, IconButton, LinearProgress, SelectField, useErrorText } from "./components";
import { SnackbarProvider, useSnackbar } from "./snackbar";
import { I18nProvider, LANGS, Lang, useI18n } from "./i18n";
import { ActivityProvider, useActivities } from "./activity";
import { storageGet, storageSet } from "./storage";
import { retainKnownScanner } from "./deviceProfile";
import DevicePicker from "./views/Devices";
import OverviewView from "./views/Overview";
import EmailProfiles from "./views/EmailProfiles";
import ScanToEmail from "./views/ScanToEmail";
import ScanView from "./views/Scan";
import CloseGuard from "./CloseGuard";
import type { SourceDoc } from "./printing";
// Printing pulls in pdf.js and pdf-lib: load it with the tab.
const PrintView = lazy(() => import("./views/Print"));
import "./App.css";

type Tab = "overview" | "print" | "scan" | "profiles" | "scan-to-email";

function loadDevice(): Device | null {
  try {
    const raw = storageGet("device");
    return raw ? (JSON.parse(raw) as Device) : null;
  } catch {
    return null;
  }
}

// What each known device supports, so picking it again opens at once; the
// probe then runs in the background and updates it.
function loadProfiles(): Record<string, DeviceProfile> {
  try {
    return JSON.parse(storageGet("profiles") ?? "{}") as Record<string, DeviceProfile>;
  } catch {
    return {};
  }
}

function saveProfile(host: string, p: DeviceProfile) {
  storageSet("profiles", JSON.stringify({ ...loadProfiles(), [host]: p }));
}

export default function App() {
  return (
    <I18nProvider>
      <SnackbarProvider>
        <ActivityProvider>
          <CloseGuard />
          <Shell />
        </ActivityProvider>
      </SnackbarProvider>
    </I18nProvider>
  );
}

function Shell() {
  const { t, lang, setLang } = useI18n();
  const errorText = useErrorText();
  const [device, setDevice] = useState<Device | null>(loadDevice);
  const snack = useSnackbar();
  const [profile, setProfile] = useState<DeviceProfile | null>(() =>
    device ? (loadProfiles()[device.host] ?? null) : null,
  );
  // Probing a device we already know: its screens stay usable meanwhile.
  const [refreshing, setRefreshing] = useState(false);
  const [probeError, setProbeError] = useState<AppError | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(() => (storageGet("tab") as Tab) ?? "overview");
  const [found, setFound] = useState<Discovered[]>(() => {
    try {
      return JSON.parse(storageGet("found") ?? "[]") as Discovered[];
    } catch {
      return [];
    }
  });
  // Documents sent to the print screen from elsewhere (the scan).
  const [toPrint, setToPrint] = useState<SourceDoc[]>([]);
  const takeToPrint = useCallback(() => setToPrint([]), []);
  const searchingRef = useRef(false);
  const [searching, setSearching] = useState(false);
  const [searchDone, setSearchDone] = useState(false);

  const connect = useCallback((d: Device) => {
    setDevice(d);
    setPickerOpen(false);
    storageSet("device", JSON.stringify(d));
  }, []);

  // Probe what the device supports whenever it changes (or on retry). A known
  // device opens right away with what it supported last time.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const cached = loadProfiles()[device.host] ?? null;
    setProfile(cached);
    setProbeError(null);
    setProbing(!cached);
    setRefreshing(!!cached);
    api
      .probe(device)
      .then((p) => {
        if (cancelled) return;
        // A UDP discovery timeout is not proof that a known scanner disappeared.
        const next = retainKnownScanner(loadProfiles()[device.host] ?? cached, p);
        saveProfile(device.host, next);
        // Same answer: keep the object so the screens don't reload.
        setProfile((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
      })
      .catch((e) => {
        if (cancelled) return;
        if (cached) snack(t("devices.refreshFailed", { name: device.name ?? device.host }), { kind: "warning" });
        else setProbeError(toAppError(e));
      })
      .finally(() => {
        if (cancelled) return;
        setProbing(false);
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, probeNonce]);

  const search = useCallback(async () => {
    if (searchingRef.current) return;
    searchingRef.current = true;
    setSearching(true);
    setSearchDone(false);
    // Merge live results into what we already know; keep earlier finds
    // because slow devices don't always answer every browse.
    const merge = (list: Discovered[]) =>
      setFound((prev) => {
        const byHost = new Map(prev.map((d) => [d.host.toLowerCase(), d]));
        for (const d of list) byHost.set(d.host.toLowerCase(), d);
        const next = [...byHost.values()].sort((a, b) => a.name.localeCompare(b.name));
        storageSet("found", JSON.stringify(next));
        return next;
      });
    const un = await listen<Discovered[]>("discovery-update", (e) => merge(e.payload));
    try {
      merge(await api.discover());
    } catch {
      /* shown as "none found" */
    } finally {
      un();
      searchingRef.current = false;
      setSearching(false);
      setSearchDone(true);
    }
  }, []);

  // First run: look for devices right away.
  useEffect(() => {
    if (!device) search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openPicker() {
    setPickerOpen(true);
    if (!searchDone && !searching) search();
  }

  function selectTab(tb: Tab) {
    setTab(tb);
    storageSet("tab", tb);
  }

  // Scanner calls need the protocol/URL found by the probe.
  const scanDevice = useMemo<Device | null>(
    () =>
      device && profile
        ? { ...device, hints: { ...device.hints, scanProtocol: profile.scanProtocol, wsscanUrl: profile.wsscanUrl } }
        : null,
    [device, profile],
  );

  const f = profile?.features;
  const tabs: { id: Tab; label: string; icon: string; show: boolean }[] = [
    { id: "overview", label: t("tabs.overview"), icon: "dashboard", show: true },
    { id: "print", label: t("tabs.print"), icon: "print", show: !!f?.ipp },
    { id: "scan", label: t("tabs.scan"), icon: "document_scanner", show: !!profile?.scanProtocol },
    { id: "profiles", label: t("tabs.profiles"), icon: "contact_mail", show: !!f?.emailProfiles },
    { id: "scan-to-email", label: t("tabs.scanToEmail"), icon: "forward_to_inbox", show: !!f?.emailProfiles },
  ];
  const visible = tabs.filter((x) => x.show);
  const activeTab = visible.some((x) => x.id === tab) ? tab : "overview";
  const activities = useActivities();

  // Screens stay mounted once opened (just hidden), so work they started —
  // a scan, a print, files being added — keeps its state when you look at
  // another screen. A new device starts fresh.
  const [opened, setOpened] = useState<{ host: string | null; tabs: Tab[] }>({ host: null, tabs: [] });
  const host = device?.host ?? null;
  const openedTabs = opened.host === host ? opened.tabs : [];
  useEffect(() => {
    setOpened((o) =>
      o.host === host
        ? o.tabs.includes(activeTab)
          ? o
          : { host, tabs: [...o.tabs, activeTab] }
        : { host, tabs: [activeTab] },
    );
  }, [host, activeTab]);
  const shown = (id: Tab) => activeTab === id || openedTabs.includes(id);
  const deviceName = device ? profile?.model ?? device.name ?? device.host : null;

  const picker = (
    <DevicePicker
      found={found}
      searching={searching}
      searchDone={searchDone}
      current={device?.host ?? null}
      onSearch={search}
      onPick={(d) =>
        connect({ host: d.host, name: d.name, hints: { esclRoot: d.esclRoot, ippResource: d.ippResource } })
      }
      onManual={(host) => connect({ host, hints: {} })}
    />
  );

  return (
    <div className="app">
      <nav className="drawer" aria-label={t("app.navigation")}>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">PaperDock</span>
        </div>

        <button
          type="button"
          className="device-switch"
          onClick={openPicker}
          aria-label={t("devices.change")}
          title={device ? device.host : t("devices.choose")}
        >
          <Icon name="print_connect" fill={!!profile} />
          <span className="device-switch-text">
            {device ? (
              <>
                <span className="title-s">{deviceName}</span>
                <span className="body-s muted">{device.host}</span>
              </>
            ) : (
              <span className="title-s">{t("devices.choose")}</span>
            )}
          </span>
          <Icon name="unfold_more" />
        </button>

        {device &&
          profile &&
          visible.map((x) => (
            <button
              key={x.id}
              type="button"
              className={activeTab === x.id ? "nav-item active" : "nav-item"}
              aria-current={activeTab === x.id ? "page" : undefined}
              onClick={() => selectTab(x.id)}
            >
              <span className="nav-icon">
                <Icon name={x.icon} />
                {activities.some((a) => a.tab === x.id) && (
                  <span
                    className={activities.some((a) => a.tab === x.id && a.needsYou) ? "nav-badge attention" : "nav-badge"}
                    aria-hidden
                  />
                )}
              </span>
              <span className="nav-label">{x.label}</span>
            </button>
          ))}

        {activities.length > 0 && (
          <div className="activities" role="status" aria-live="polite">
            {activities.map((a) => (
              <button
                key={a.tab + a.label}
                type="button"
                className={a.needsYou ? "activity attention" : "activity"}
                onClick={() => selectTab(a.tab as Tab)}
                title={a.detail ? `${a.label}: ${a.detail}` : a.label}
              >
                <Icon name={a.needsYou ? a.icon : "progress_activity"} className={a.needsYou ? undefined : "spin"} />
                <span className="activity-text">
                  <span className="title-s">{a.label}</span>
                  {a.detail && <span className="body-s">{a.detail}</span>}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="drawer-foot">
          <SelectField<Lang>
            dense
            label={t("sidebar.language")}
            value={lang}
            options={LANGS.map((l) => ({ value: l.id, label: l.label }))}
            onChange={setLang}
          />
          <IconButton
            className="lang-toggle"
            icon="translate"
            label={`${t("sidebar.language")}: ${LANGS.find((l) => l.id === lang)?.label}`}
            onClick={() => setLang(lang === "it" ? "en" : "it")}
          />
        </div>
      </nav>

      <main className="pane">
        {!device ? (
          <div className="welcome">
            <h1>{t("welcome.title")}</h1>
            <p className="body-l muted">{t("welcome.body")}</p>
            <div className="card">{picker}</div>
          </div>
        ) : probing ? (
          <>
            <div className="top-progress">
              <LinearProgress label={t("sidebar.connecting")} />
            </div>
            <div className="connecting">
              <h1>{t("devices.connecting", { name: device.name ?? device.host })}</h1>
              <p className="muted">{t("devices.connectingBody")}</p>
            </div>
          </>
        ) : probeError || !profile ? (
          <div className="page">
            <EmptyState
              error
              icon="print_disabled"
              title={t("devices.failed", { name: device.name ?? device.host })}
              body={probeError ? errorText(probeError) : undefined}
            >
              <Button icon="refresh" onClick={() => setProbeNonce((n) => n + 1)}>
                {t("common.retry")}
              </Button>
              <Button variant="outlined" onClick={openPicker}>
                {t("devices.chooseOther")}
              </Button>
            </EmptyState>
          </div>
        ) : (
          <>
            {refreshing && (
              <div className="top-progress refresh-progress">
                <LinearProgress label={t("sidebar.connecting")} />
              </div>
            )}
            {shown("overview") && (
              <div className="tab-panel" hidden={activeTab !== "overview"}>
                <OverviewView key={device.host} device={device} profile={profile} />
              </div>
            )}
            {shown("print") && f?.ipp && (
              <div className="tab-panel" hidden={activeTab !== "print"}>
                <Suspense
                  fallback={
                    <div className="top-progress">
                      <LinearProgress label={t("common.loading")} />
                    </div>
                  }
                >
                  <PrintView
                    key={device.host}
                    active={activeTab === "print"}
                    device={device}
                    deviceName={deviceName ?? device.host}
                    incoming={toPrint}
                    onIncomingTaken={takeToPrint}
                  />
                </Suspense>
              </div>
            )}
            {shown("scan") && scanDevice && (
              <div className="tab-panel" hidden={activeTab !== "scan"}>
                <ScanView
                  key={device.host}
                  active={activeTab === "scan"}
                  device={scanDevice}
                  onPrint={
                    f?.ipp
                      ? (doc) => {
                          setToPrint((d) => [...d, doc]);
                          selectTab("print");
                        }
                      : undefined
                  }
                />
              </div>
            )}
            {shown("profiles") && f?.emailProfiles && (
              <div className="tab-panel" hidden={activeTab !== "profiles"}>
                <EmailProfiles key={device.host} host={device.host} />
              </div>
            )}
            {shown("scan-to-email") && f?.emailProfiles && (
              <div className="tab-panel" hidden={activeTab !== "scan-to-email"}>
                <ScanToEmail key={device.host} host={device.host} />
              </div>
            )}
          </>
        )}
      </main>

      <Dialog
        open={pickerOpen && !!device}
        onClose={() => setPickerOpen(false)}
        title={t("devices.title")}
        actions={
          <Button variant="text" onClick={() => setPickerOpen(false)}>
            {t("common.close")}
          </Button>
        }
      >
        {picker}
      </Dialog>
    </div>
  );
}
