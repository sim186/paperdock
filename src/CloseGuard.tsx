import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { Button, Dialog } from "./components";
import { useI18n } from "./i18n";

type Reason = "unsaved" | "scanning" | "both" | "unknown";

/** Protect the backend session even when the scan screen is not mounted. */
export default function CloseGuard() {
  const { t } = useI18n();
  const [reason, setReason] = useState<Reason | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let disposed = false;
    const unlisten = window.onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        const status = await api.closeStatus();
        if (disposed) return;
        if (!status.scanning && !status.unsavedPages) {
          await window.destroy();
        } else {
          setReason(status.scanning && status.unsavedPages ? "both" : status.scanning ? "scanning" : "unsaved");
        }
      } catch {
        if (!disposed) setReason("unknown");
      }
    });
    return () => {
      disposed = true;
      void unlisten.then((unregister) => unregister());
    };
  }, []);

  return (
    <Dialog
      open={reason !== null}
      onClose={() => setReason(null)}
      title={t("closeGuard.title")}
      icon="warning"
      small
      actions={<>
        <Button variant="text" onClick={() => setReason(null)}>{t("closeGuard.stay")}</Button>
        <Button variant="danger-text" onClick={() => void getCurrentWindow().destroy()}>{t("closeGuard.close")}</Button>
      </>}
    >
      {reason && t(`closeGuard.${reason}`)}
    </Dialog>
  );
}
