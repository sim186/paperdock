import { useState } from "react";
import { api, AppError, EmailAccount, toAppError } from "../api";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  LinearProgress,
  PageHeader,
  Switch,
  useErrorText,
} from "../components";
import { useSnackbar } from "../snackbar";
import { useLoad } from "../hooks";
import { useI18n } from "../i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  cleanAppPassword,
  defaultDisplayName,
  EmailProvider,
  PROVIDERS,
  providerForEmail,
  providerForServer,
} from "./emailProviders";

const MAX_PROFILES = 20;

const EMPTY: EmailAccount = {
  id: null,
  displayName: "",
  emailAddress: "",
  smtpServer: "",
  port: 587,
  maxAttachmentSize: 0,
  useSsl: true,
  ccToSelf: false,
  username: "",
  password: "",
  pin: "",
};

/** Guided steps per provider that needs an app password (i18n keys under emailSetup.steps). */
const STEP_COUNT = 3;

async function openExternal(url: string) {
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

export default function EmailProfiles({ host }: { host: string }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const snack = useSnackbar();
  const { data, error, loading, reload } = useLoad(() => api.emailAccounts(host), [host]);
  const [editing, setEditing] = useState<EmailAccount | null>(null);
  /** New-profile wizard: "choose" shows the provider list, a provider shows its quick setup. */
  const [wizard, setWizard] = useState<"choose" | EmailProvider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<EmailAccount | null>(null);

  async function runTest(a: EmailAccount) {
    if (!a.id) return;
    setBusyId(a.id);
    try {
      const result = await api.testEmailAccount(host, a.id);
      const ok = /success|ok|passed/i.test(result);
      snack(ok ? t("profiles.testOk", { name: a.displayName }) : t("profiles.testResult", { result }), {
        kind: ok ? "success" : "error",
      });
    } catch (e) {
      snack(errorText(toAppError(e)), { kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function remove(a: EmailAccount) {
    if (!a.id) return;
    setBusyId(a.id);
    try {
      await api.deleteEmailAccount(host, a.id);
      setConfirmDelete(null);
      snack(t("profiles.deleted", { name: a.displayName }), { kind: "success" });
      await reload();
    } catch (e) {
      snack(errorText(toAppError(e)), { kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  if (wizard === "choose") {
    return (
      <ProviderPicker
        onCancel={() => setWizard(null)}
        onPick={(p) => setWizard(p)}
        onOther={() => {
          setWizard(null);
          setEditing({ ...EMPTY });
        }}
      />
    );
  }

  if (wizard) {
    return (
      <QuickSetup
        key={wizard.id}
        host={host}
        provider={wizard}
        onBack={() => setWizard("choose")}
        onSwitch={(p) => setWizard(p)}
        onAdvanced={(a) => {
          setWizard(null);
          setEditing(a);
        }}
        onCreated={async (a) => {
          setWizard(null);
          snack(t("profiles.created", { name: a.displayName }), { kind: "success" });
          await reload();
          await runTest(a);
        }}
      />
    );
  }

  if (editing) {
    return (
      <ProfileEditor
        host={host}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSaved={async (msg) => {
          setEditing(null);
          snack(msg, { kind: "success" });
          await reload();
        }}
      />
    );
  }

  const count = data?.length ?? 0;
  const full = count >= MAX_PROFILES;

  return (
    <>
      {loading && (
        <div className="top-progress">
          <LinearProgress label={t("common.loading")} />
        </div>
      )}
      <section className="page">
        <PageHeader
          title={t("profiles.title")}
          subtitle={data ? t("profiles.subtitle", { n: count, max: MAX_PROFILES }) : t("profiles.subtitleShort")}
        >
          <IconButton icon="refresh" label={t("common.refresh")} onClick={reload} disabled={loading} />
          {count > 0 && (
            <Button icon="add" onClick={() => setWizard("choose")} disabled={full} title={full ? t("profiles.full") : undefined}>
              {t("profiles.add")}
            </Button>
          )}
        </PageHeader>

        <ErrorBanner error={error} onRetry={reload} />

        {data && data.length === 0 && (
          <div className="card">
            <EmptyState icon="contact_mail" title={t("profiles.empty")} body={t("profiles.emptyBody")}>
              <Button icon="add" onClick={() => setWizard("choose")}>
                {t("profiles.createFirst")}
              </Button>
            </EmptyState>
          </div>
        )}

        {data && data.length > 0 && (
          <div className="card outlined profiles-card">
            <ul className="list">
              {data.map((a, i) => {
                const id = a.id;
                return (
                  <li key={id ?? i}>
                    <div className="list-row three">
                      <span className="avatar" aria-hidden>
                        {(a.displayName || a.emailAddress || "?").charAt(0).toUpperCase()}
                      </span>
                      <div className="body">
                        <span className="headline">{a.displayName}</span>
                        <span className="supporting">{a.emailAddress}</span>
                        <div className="profile-meta">
                          <span className="chip small has-icon">
                            <Icon name="dns" />
                            {a.smtpServer}:{a.port}
                          </span>
                          {a.useSsl && (
                            <span className="chip small has-icon">
                              <Icon name="lock" />
                              SSL/TLS
                            </span>
                          )}
                          <span className="chip small has-icon">
                            <Icon name={a.username ? "person" : "person_off"} />
                            {a.username ? a.username : t("profiles.noAuth")}
                          </span>
                        </div>
                      </div>
                      {id ? (
                        <div className="profile-actions">
                          <Button
                            variant="text"
                            icon="send"
                            busy={busyId === id}
                            onClick={() => runTest(a)}
                            disabled={busyId !== null}
                          >
                            {busyId === id ? t("profiles.testing") : t("profiles.test")}
                          </Button>
                          <IconButton
                            icon="edit"
                            label={t("common.edit")}
                            onClick={() => setEditing({ ...a, password: null, pin: null })}
                          />
                          <IconButton icon="delete" label={t("common.delete")} onClick={() => setConfirmDelete(a)} />
                        </div>
                      ) : (
                        <span className="muted body-s">{t("profiles.unknownId")}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("profiles.confirmDeleteTitle", { name: confirmDelete?.displayName ?? "" })}
        body={t("profiles.confirmDeleteBody")}
        confirm={t("common.delete")}
        busy={busyId !== null && busyId === confirmDelete?.id}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
      />
    </>
  );
}

function ProfileEditor({
  host,
  initial,
  onCancel,
  onSaved,
}: {
  host: string;
  initial: EmailAccount;
  onCancel: () => void;
  onSaved: (msg: string) => void;
}) {
  const { t } = useI18n();
  const isNew = initial.id === null;
  const [a, setA] = useState<EmailAccount>(initial);
  const [auth, setAuth] = useState(isNew || !!initial.username);
  const [changePassword, setChangePassword] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const set = <K extends keyof EmailAccount>(k: K, v: EmailAccount[K]) => setA((prev) => ({ ...prev, [k]: v }));
  const preset = providerForServer(a.smtpServer, a.port);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const payload: EmailAccount = {
      ...a,
      username: auth ? a.username?.trim() || null : null,
      password: auth && changePassword ? a.password ?? "" : null,
      pin: a.pin?.trim() || null,
    };
    try {
      await api.saveEmailAccount(host, payload);
      onSaved(isNew ? t("profiles.created", { name: a.displayName }) : t("profiles.updated", { name: a.displayName }));
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page">
      <PageHeader
        lead={<IconButton icon="arrow_back" label={t("common.back")} onClick={onCancel} disabled={saving} />}
        title={isNew ? t("profiles.newTitle") : t("profiles.editTitle", { name: initial.displayName })}
        subtitle={t("profiles.storedOnDevice")}
      />

      <ErrorBanner error={error} />

      <form onSubmit={save}>
        <div className="card form-card">
          <section className="form-section">
            <h2 className="form-legend">{t("profiles.sender")}</h2>
            <div className="grid-2">
              <Field label={t("profiles.displayName")} hint={t("profiles.displayNameHint")} counter={`${a.displayName.length}/25`}>
                <input required maxLength={25} value={a.displayName} onChange={(e) => set("displayName", e.target.value)} />
              </Field>
              <Field label={t("profiles.emailAddress")}>
                <input
                  required
                  type="email"
                  maxLength={50}
                  spellCheck={false}
                  value={a.emailAddress}
                  onChange={(e) => set("emailAddress", e.target.value)}
                />
              </Field>
            </div>
          </section>

          <section className="form-section">
            <h2 className="form-legend">{t("profiles.server")}</h2>
            <p className="section-hint">{t("profiles.presetsHint")}</p>
            <div className="chips">
              {PROVIDERS.map((p) => {
                const on = preset?.id === p.id;
                return (
                  <button
                    type="button"
                    key={p.id}
                    className={on ? "chip ripple selected has-icon" : "chip ripple"}
                    aria-pressed={on}
                    onClick={() => setA((prev) => ({ ...prev, smtpServer: p.server, port: p.port, useSsl: p.ssl }))}
                  >
                    {on && <Icon name="check" />}
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="grid-2 port">
              <Field label={t("profiles.host")}>
                <input
                  required
                  maxLength={100}
                  spellCheck={false}
                  autoCapitalize="off"
                  placeholder="smtp.example.com"
                  value={a.smtpServer}
                  onChange={(e) => set("smtpServer", e.target.value)}
                />
              </Field>
              <Field label={t("profiles.port")}>
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={a.port}
                  onChange={(e) => set("port", Number(e.target.value))}
                />
              </Field>
            </div>
            <div className="switch-group">
              <Switch label={t("profiles.useSsl")} checked={a.useSsl} onChange={(v) => set("useSsl", v)} />
            </div>
            <Field label={t("profiles.maxAttachment")} hint={t("profiles.maxAttachmentHint")}>
              <input
                type="number"
                min={0}
                max={999}
                value={a.maxAttachmentSize}
                onChange={(e) => set("maxAttachmentSize", Number(e.target.value))}
              />
            </Field>
          </section>

          <section className="form-section">
            <h2 className="form-legend">{t("profiles.auth")}</h2>
            <div className="switch-group">
              <Switch label={t("profiles.authRequired")} checked={auth} onChange={setAuth} />
            </div>
            {auth && (
              <div className="grid-2">
                <Field label={t("profiles.username")}>
                  <input
                    required
                    maxLength={50}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    value={a.username ?? ""}
                    onChange={(e) => set("username", e.target.value)}
                  />
                </Field>
                {changePassword ? (
                  <Field label={t("profiles.password")} hint={isNew ? t("profiles.passwordHint") : t("profiles.passwordNew")}>
                    <input
                      type="password"
                      maxLength={50}
                      autoComplete="new-password"
                      value={a.password ?? ""}
                      onChange={(e) => set("password", e.target.value)}
                    />
                  </Field>
                ) : (
                  <div className="field-aligned">
                    <Button variant="outlined" icon="key" onClick={() => setChangePassword(true)}>
                      {t("profiles.changePassword")}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="form-section">
            <h2 className="form-legend">{t("profiles.options")}</h2>
            <div className="switch-group">
              <Switch label={t("profiles.ccToSelf")} checked={a.ccToSelf} onChange={(v) => set("ccToSelf", v)} />
            </div>
            <div className="grid-2">
              <Field label={t("profiles.pin")} hint={isNew ? t("profiles.pinHintNew") : t("profiles.pinHintEdit")}>
                <input
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  autoComplete="off"
                  value={a.pin ?? ""}
                  onChange={(e) => set("pin", e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
          </section>
        </div>

        <div className="form-bar">
          <Button variant="text" onClick={onCancel} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" icon={isNew ? "add" : "check"} busy={saving} disabled={saving}>
            {saving ? t("common.saving") : isNew ? t("profiles.createAction") : t("common.save")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ProviderPicker({
  onPick,
  onOther,
  onCancel,
}: {
  onPick: (p: EmailProvider) => void;
  onOther: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="page">
      <PageHeader
        lead={<IconButton icon="arrow_back" label={t("common.back")} onClick={onCancel} />}
        title={t("emailSetup.chooseTitle")}
        subtitle={t("emailSetup.chooseSubtitle")}
      />
      <div className="card outlined">
        <ul className="list">
          {PROVIDERS.map((p) => (
            <li key={p.id}>
              <button type="button" className="list-row ripple" onClick={() => onPick(p)}>
                <span className="avatar" aria-hidden>
                  {p.label.charAt(0)}
                </span>
                <span className="body">
                  <span className="headline">{p.label}</span>
                  <span className="supporting">{p.domains.length ? p.domains.slice(0, 3).join(", ") : p.server}</span>
                </span>
                <Icon name="chevron_right" className="lead" />
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="list-row ripple" onClick={onOther}>
              <span className="avatar" aria-hidden>
                <Icon name="dns" />
              </span>
              <span className="body">
                <span className="headline">{t("emailSetup.other")}</span>
                <span className="supporting">{t("emailSetup.otherBody")}</span>
              </span>
              <Icon name="chevron_right" className="lead" />
            </button>
          </li>
        </ul>
      </div>
    </section>
  );
}

function QuickSetup({
  host,
  provider,
  onBack,
  onSwitch,
  onAdvanced,
  onCreated,
}: {
  host: string;
  provider: EmailProvider;
  onBack: () => void;
  onSwitch: (p: EmailProvider) => void;
  onAdvanced: (a: EmailAccount) => void;
  onCreated: (a: EmailAccount) => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const displayName = nameTouched ? name : defaultDisplayName(email);
  const detected = providerForEmail(email);
  const mismatch = detected && detected.id !== provider.id ? detected : null;

  function account(): EmailAccount {
    const addr = email.trim();
    return {
      ...EMPTY,
      displayName: displayName.trim() || defaultDisplayName(addr),
      emailAddress: addr,
      smtpServer: provider.server,
      port: provider.port,
      useSsl: provider.ssl,
      username: addr,
      password: provider.appPassword ? cleanAppPassword(password) : password,
    };
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const a = account();
    try {
      const id = await api.saveEmailAccount(host, a);
      onCreated({ ...a, id, password: null });
    } catch (err) {
      setError(toAppError(err));
      setSaving(false);
    }
  }

  const steps = provider.appPassword
    ? Array.from({ length: STEP_COUNT }, (_, i) => t(`emailSetup.steps.${provider.id}${i + 1}`))
    : [];

  return (
    <section className="page">
      <PageHeader
        lead={<IconButton icon="arrow_back" label={t("common.back")} onClick={onBack} disabled={saving} />}
        title={t("emailSetup.setupTitle", { provider: provider.label })}
        subtitle={t("emailSetup.setupSubtitle")}
      />

      <ErrorBanner error={error} />

      <form onSubmit={connect}>
        <div className="card form-card">
          <section className="form-section">
            <Field label={t("emailSetup.email", { provider: provider.label })}>
              <input
                required
                autoFocus
                type="email"
                maxLength={50}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            {mismatch && (
              <div className="banner info" role="status">
                <Icon name="info" />
                <span className="banner-text">{t("emailSetup.wrongProvider", { provider: mismatch.label })}</span>
                <Button variant="text" onClick={() => onSwitch(mismatch)}>
                  {t("emailSetup.switchProvider", { provider: mismatch.label })}
                </Button>
              </div>
            )}
          </section>

          <section className="form-section">
            <h2 className="form-legend">{provider.appPassword ? t("emailSetup.appPassword") : t("emailSetup.password")}</h2>
            {provider.warning && (
              <div className="banner warn" role="note">
                <Icon name="warning" />
                <span className="banner-text">{t("emailSetup.warnOutlook")}</span>
              </div>
            )}
            {steps.length > 0 && (
              <ol className="setup-steps">
                {steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
            {provider.helpUrl && (
              <div>
                <Button variant="outlined" icon="open_in_new" onClick={() => openExternal(provider.helpUrl!)}>
                  {t("emailSetup.openPage")}
                </Button>
              </div>
            )}
            <Field
              label={provider.appPassword ? t("emailSetup.appPassword") : t("emailSetup.password")}
              hint={provider.appPassword ? t("emailSetup.spacesRemoved") : t("emailSetup.passwordHint")}
            >
              <input
                required
                type="password"
                maxLength={provider.appPassword ? 64 : 50}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </section>

          <section className="form-section">
            <Field label={t("emailSetup.displayName")} hint={t("profiles.displayNameHint")} counter={`${displayName.length}/25`}>
              <input
                required
                maxLength={25}
                value={displayName}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
              />
            </Field>
          </section>
        </div>

        <div className="form-bar">
          <Button variant="text" icon="tune" onClick={() => onAdvanced(account())} disabled={saving}>
            {t("emailSetup.advanced")}
          </Button>
          <span className="grow" />
          <Button type="submit" icon="link" busy={saving} disabled={saving}>
            {saving ? t("emailSetup.connecting") : t("emailSetup.connect")}
          </Button>
        </div>
      </form>
    </section>
  );
}
