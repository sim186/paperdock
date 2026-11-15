import { useState } from "react";
import { Discovered } from "../api";
import { Button, Field, Icon, LinearProgress } from "../components";
import { useI18n } from "../i18n";

/** Devices found on the network, plus a field to type an address. */
export default function DevicePicker({
  found,
  searching,
  searchDone,
  current,
  onSearch,
  onPick,
  onManual,
}: {
  found: Discovered[];
  searching: boolean;
  searchDone: boolean;
  current: string | null;
  onSearch: () => void;
  onPick: (d: Discovered) => void;
  onManual: (host: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const host = draft.trim();

  const kind = (d: Discovered) =>
    d.printer && d.scanner ? t("devices.kindBoth") : d.scanner ? t("devices.kindScanner") : t("devices.kindPrinter");

  return (
    <div>
      <div className="picker-head">
        <h2 className="title-m grow">{t("devices.onNetwork")}</h2>
        <Button variant="text" icon="refresh" busy={searching} disabled={searching} onClick={onSearch}>
          {searching ? t("sidebar.searching") : t("devices.searchAgain")}
        </Button>
      </div>
      {searching && <LinearProgress label={t("sidebar.searching")} />}

      <div className="picker-list">
        {found.length > 0 ? (
          <ul className="list plain">
            {found.map((d) => {
              const active = d.host === current;
              return (
                <li key={d.host}>
                  <button
                    type="button"
                    className={active ? "list-row selected" : "list-row"}
                    onClick={() => onPick(d)}
                    aria-current={active || undefined}
                  >
                    <Icon name={d.scanner && !d.printer ? "scanner" : "print"} className="lead" />
                    <span className="body">
                      <span className="headline">{d.name}</span>
                      <span className="supporting">
                        {kind(d)}, {d.addresses[0] ?? d.host}
                      </span>
                    </span>
                    {active && <Icon name="check" />}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="picker-note">
            {searchDone ? t("sidebar.noneFound") : searching ? t("devices.lookingFor") : t("devices.notSearched")}
          </p>
        )}
      </div>

      <form
        className="picker-manual"
        onSubmit={(e) => {
          e.preventDefault();
          if (host) onManual(host);
        }}
      >
        <Field label={t("devices.address")} hint={t("devices.addressHint")}>
          <input
            value={draft}
            placeholder={t("sidebar.hostPlaceholder")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="tonal" disabled={!host || host === current}>
          {t("sidebar.use")}
        </Button>
      </form>
    </div>
  );
}
