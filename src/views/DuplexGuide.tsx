import { useEffect, useRef, useState } from "react";
import { Button, Icon, IconButton } from "../components";
import { useI18n } from "../i18n";
import "./DuplexGuide.css";

export default function DuplexGuide({
  open, count, ready, empty, onClose, onScan,
}: {
  open: boolean;
  count: number | null;
  ready: boolean;
  empty: boolean;
  onClose: () => void;
  onScan: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  useEffect(() => { if (open) setStep(0); }, [open]);
  const steps = [
    { title: t("scan.guideTakeTitle"), body: t("scan.guideTakeBody"), icon: "stacks" },
    { title: t("scan.guideFlipTitle"), body: t("scan.guideFlipBody"), icon: "flip" },
    { title: t("scan.guideCheckTitle"), body: t("scan.guideCheckBody"), icon: "fact_check" },
  ];
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className="duplex-guide" aria-labelledby="duplex-guide-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {open && <>
        <div className="duplex-guide-top">
          <span className="duplex-guide-eyebrow"><Icon name="auto_stories" /> {t("scan.guideEyebrow")}</span>
          <IconButton icon="close" label={t("common.close")} onClick={onClose} />
        </div>
        <div className="duplex-guide-content">
          <div className="duplex-guide-visual" aria-hidden="true">
            <span className="duplex-orbit duplex-orbit-one" />
            <span className="duplex-orbit duplex-orbit-two" />
            <div key={step} className={`duplex-stack duplex-stack-step-${step}`}>
              <span className="duplex-paper duplex-paper-back" />
              <span className="duplex-paper duplex-paper-mid" />
              <span className="duplex-paper duplex-paper-front"><i /><i /><i /><b /></span>
            </div>
            <span className="duplex-visual-caption"><Icon name={steps[step].icon} /> {t("scan.guideVisual")}</span>
          </div>
          <div className="duplex-guide-copy">
            <span className="duplex-guide-kicker">{t(count === null ? "scan.guidePreviewStep" : "scan.flipStep")}</span>
            <h2 id="duplex-guide-title">{t("scan.guideTitle")}</h2>
            <p className="duplex-guide-intro">{count === null ? t("scan.guidePreviewIntro") : t("scan.guideIntro", { n: count })}</p>
            <div className="duplex-step-progress" aria-label={t("scan.guideStepCount", { n: step + 1 })}>
              {steps.map((item, index) => (
                <button key={item.title} type="button" className={index === step ? "active" : ""} aria-label={`${index + 1}. ${item.title}`} aria-current={index === step ? "step" : undefined} onClick={() => setStep(index)}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </button>
              ))}
            </div>
            <div className="duplex-current-step" aria-live="polite">
              <span>{t("scan.guideStepCount", { n: step + 1 })}</span>
              <h3>{steps[step].title}</h3>
              <p>{steps[step].body}</p>
            </div>
            <p className="duplex-guide-tip"><Icon name="lightbulb" /> {t("scan.guideTip")}</p>
            {count !== null && empty && <p className="duplex-guide-warning">{t("scan.feederEmptyHint")}</p>}
            {count !== null && !ready && !empty && <p className="duplex-guide-warning">{t("scan.guideNotReady")}</p>}
            <div className="duplex-guide-actions">
              {step === 0
                ? <Button variant="text" onClick={onClose}>{t("scan.guideLater")}</Button>
                : <Button variant="text" onClick={() => setStep((n) => n - 1)}>{t("scan.guidePrevious")}</Button>}
              {step < 2
                ? <Button icon="arrow_forward" onClick={() => setStep((n) => n + 1)}>{t("scan.guideNext")}</Button>
                : count !== null
                  ? <Button icon="document_scanner" onClick={onScan} disabled={!ready}>{t("scan.scanBacks")}</Button>
                  : <Button onClick={onClose}>{t("scan.guideDone")}</Button>}
            </div>
          </div>
        </div>
      </>}
    </dialog>
  );
}
