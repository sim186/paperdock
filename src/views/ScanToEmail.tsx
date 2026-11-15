import { useEffect, useState } from "react";
import { api, ScanToEmailSettings, toAppError } from "../api";
import {
  Button,
  ErrorBanner,
  Field,
  IconButton,
  LinearProgress,
  PageHeader,
  SelectField,
  Switch,
  useErrorText,
} from "../components";
import { useSnackbar } from "../snackbar";
import { useLoad } from "../hooks";
import { useHas, useI18n } from "../i18n";

export default function ScanToEmail({ host }: { host: string }) {
  const { t } = useI18n();
  const has = useHas();
  const errorText = useErrorText();
  const snack = useSnackbar();
  const { data, error, loading, reload } = useLoad(() => api.scanToEmail(host), [host]);
  const [s, setS] = useState<ScanToEmailSettings | null>(null);
  const [saving, setSaving] = useState(false);

  // Local copy to edit; the loaded one is the baseline for "unsaved changes".
  useEffect(() => {
    if (data) setS(data.settings);
  }, [data]);

  const label = (v: string) => (has(`scanToEmail.values.${v}`) ? t(`scanToEmail.values.${v}`) : v.replace("dpi", " dpi"));

  const head = (
    <PageHeader title={t("scanToEmail.title")} subtitle={t("scanToEmail.subtitle")}>
      <IconButton icon="refresh" label={t("common.reload")} onClick={reload} disabled={loading || saving} />
    </PageHeader>
  );

  if (!data || !s) {
    return (
      <>
        {loading && (
          <div className="top-progress">
            <LinearProgress label={t("common.loading")} />
          </div>
        )}
        <section className="page">
          {head}
          <ErrorBanner error={error} onRetry={reload} />
        </section>
      </>
    );
  }

  const o = data.options;
  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings);
  const set = <K extends keyof ScanToEmailSettings>(k: K, v: ScanToEmailSettings[K]) => setS({ ...s, [k]: v });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setSaving(true);
    try {
      await api.setScanToEmail(host, s);
      snack(t("scanToEmail.saved"), { kind: "success" });
      await reload();
    } catch (err) {
      snack(errorText(toAppError(err)), { kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  const options = (values: string[]) => values.map((v) => ({ value: v, label: label(v) }));

  return (
    <>
      {loading && (
        <div className="top-progress">
          <LinearProgress label={t("common.loading")} />
        </div>
      )}
      <section className="page">
        {head}

        <form onSubmit={save}>
          <label className={s.enabled ? "toggle-card" : "toggle-card off"}>
            <span className="switch-text">
              <span className="title-m">{t("scanToEmail.enabled")}</span>
              <small>{s.enabled ? t("scanToEmail.enabledOn") : t("scanToEmail.enabledOff")}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={s.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
          </label>

          <div className="card form-card">
            <section className="form-section">
              <h2 className="form-legend">{t("scanToEmail.message")}</h2>
              <Field label={t("scanToEmail.subject")} counter={`${s.subject.length}/${o.subjectMax}`}>
                <input maxLength={o.subjectMax} value={s.subject} onChange={(e) => set("subject", e.target.value)} />
              </Field>
              <div className="switch-group">
                <Switch
                  label={t("scanToEmail.useBody")}
                  checked={s.defaultBodyEnabled}
                  onChange={(v) => set("defaultBodyEnabled", v)}
                />
              </div>
              {s.defaultBodyEnabled && (
                <Field label={t("scanToEmail.body")} counter={`${s.body.length}/${o.bodyMax}`}>
                  <textarea rows={4} maxLength={o.bodyMax} value={s.body} onChange={(e) => set("body", e.target.value)} />
                </Field>
              )}
            </section>

            <section className="form-section">
              <h2 className="form-legend">{t("scanToEmail.attachment")}</h2>
              <div className="grid-2">
                <SelectField label={t("scanToEmail.fileType")} value={s.fileType} onChange={(v) => set("fileType", v)} options={options(o.fileTypes)} />
                <SelectField label={t("scanToEmail.color")} value={s.color} onChange={(v) => set("color", v)} options={options(o.colors)} />
                <SelectField label={t("scanToEmail.resolution")} value={s.resolution} onChange={(v) => set("resolution", v)} options={options(o.resolutions)} />
                <SelectField label={t("scanToEmail.paper")} value={s.mediaSize} onChange={(v) => set("mediaSize", v)} options={options(o.mediaSizes)} />
              </div>
              <Field
                label={t("scanToEmail.prefix")}
                counter={`${s.fileNamePrefix.length}/${o.prefixMax}`}
              >
                <input
                  maxLength={o.prefixMax}
                  spellCheck={false}
                  value={s.fileNamePrefix}
                  onChange={(e) => set("fileNamePrefix", e.target.value)}
                />
              </Field>
            </section>
          </div>

          <div className="form-bar">
            <span className="grow">{dirty ? t("common.unsaved") : t("common.allSaved")}</span>
            <Button variant="text" onClick={() => setS(data.settings)} disabled={!dirty || saving}>
              {t("common.discard")}
            </Button>
            <Button type="submit" icon="check" busy={saving} disabled={!dirty || saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </form>
      </section>
    </>
  );
}
