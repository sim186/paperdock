// Material 3 snackbar used to report states: brief messages at the bottom of
// the window, one at a time, queued in order.
//
//   const snack = useSnackbar();
//   snack("Copied");                                         // info, 4 s
//   snack("Saved", { kind: "success" });
//   snack("Toner low", { kind: "warning" });
//   snack(errorText(e), { kind: "error" });                  // 8 s
//   snack("Saved scan.pdf", { action: { label: "Show", run: reveal } });
//
//   const job = snack("Sending…", { kind: "progress" });     // stays up
//   job.update("Printing…", { progress: 0.5 });
//   job.update("Printed", { kind: "success" });              // then times out
//
// The timer pauses while the pointer or focus is on the snackbar and while
// the window is hidden, so nothing is missed. Escape dismisses it.
import { createContext, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Icon, IconButton } from "./components";
import { useI18n } from "./i18n";

export type SnackKind = "info" | "success" | "warning" | "error" | "progress";

export interface SnackOptions {
  kind?: SnackKind;
  action?: { label: string; run: () => void };
  /** Milliseconds on screen, or `null` to stay until dismissed or updated. */
  duration?: number | null;
  /** For `progress`: 0–1 shows a determinate bar; omitted is indeterminate. */
  progress?: number;
  /** A new snack with the same key replaces the one queued or shown. */
  key?: string;
}

export interface SnackHandle {
  update: (text?: string, opts?: Omit<SnackOptions, "key">) => void;
  dismiss: () => void;
}

export type ShowSnack = (text: string, opts?: SnackOptions) => SnackHandle;

interface Snack {
  id: number;
  key?: string;
  text: string;
  kind: SnackKind;
  action?: SnackOptions["action"];
  duration: number | null;
  progress?: number;
  /** Bumped on every update so the timer restarts. */
  rev: number;
}

const ICONS: Record<SnackKind, string | null> = {
  info: null,
  success: "check_circle",
  warning: "warning",
  error: "error",
  progress: "progress_activity",
};

/** M3: 4–10 s. Anything the user may need to act on or reread stays longer. */
function defaultDuration(kind: SnackKind, hasAction: boolean): number | null {
  if (kind === "progress") return null;
  if (kind === "error" || kind === "warning" || hasAction) return 8000;
  return 4000;
}

const EXIT_MS = 150;

/** Sticky bars at the bottom of a screen; the snackbar sits above them. */
const BOTTOM_BARS = ".doc-bar, .form-bar";

/** Distance from the window bottom that clears any visible bottom bar. */
function useClearance(active: boolean) {
  const [bottom, setBottom] = useState(24);
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      // Height of the box `position: fixed` measures from (not innerHeight,
      // which can include browser UI).
      const vh = document.documentElement.clientHeight;
      let clear = 24;
      for (const el of document.querySelectorAll<HTMLElement>(BOTTOM_BARS)) {
        if (!el.offsetParent) continue; // hidden (e.g. a tab in the background)
        const r = el.getBoundingClientRect();
        if (r.top < vh) clear = Math.max(clear, vh - r.top + 12);
      }
      setBottom(clear);
    };
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    // Bars come and go (screens load, tabs switch) while a snack is up.
    const ro = new ResizeObserver(later);
    const observeBars = () => document.querySelectorAll(BOTTOM_BARS).forEach((el) => ro.observe(el));
    observeBars();
    const mo = new MutationObserver(() => {
      observeBars();
      later();
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    window.addEventListener("resize", later);
    window.addEventListener("scroll", later, true);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", later);
      window.removeEventListener("scroll", later, true);
    };
  }, [active]);
  return bottom;
}

const SnackCtx = createContext<ShowSnack>(() => ({ update: () => {}, dismiss: () => {} }));

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Snack[]>([]);
  const [leaving, setLeaving] = useState(false);
  const nextId = useRef(1);
  const keyIds = useRef(new Map<string, number>());
  const current = queue[0] ?? null;

  const queueRef = useRef(queue);
  queueRef.current = queue;

  const remove = useCallback((id: number) => {
    // The visible one animates out first (see the effect below); queued ones just go.
    const gone = queueRef.current.find((s) => s.id === id);
    if (gone?.key && keyIds.current.get(gone.key) === id) keyIds.current.delete(gone.key);
    if (queueRef.current[0]?.id === id) setLeaving(true);
    else setQueue((q) => q.filter((s) => s.id !== id));
  }, []);

  const patch = useCallback((id: number, text?: string, opts?: Omit<SnackOptions, "key">) => {
    setQueue((q) =>
      q.map((s) => {
        if (s.id !== id) return s;
        const kind = opts?.kind ?? s.kind;
        const action = opts && "action" in opts ? opts.action : s.action;
        const kindChanged = kind !== s.kind;
        return {
          ...s,
          text: text ?? s.text,
          kind,
          action,
          progress: opts && "progress" in opts ? opts.progress : kindChanged ? undefined : s.progress,
          duration:
            opts && "duration" in opts
              ? (opts.duration ?? null)
              : kindChanged
                ? defaultDuration(kind, !!action)
                : s.duration,
          rev: s.rev + 1,
        };
      }),
    );
  }, []);

  const show = useCallback<ShowSnack>(
    (text, opts = {}) => {
      const kind = opts.kind ?? "info";
      // Same key: reuse the id so earlier handles keep working.
      let id = opts.key ? keyIds.current.get(opts.key) : undefined;
      if (id === undefined) {
        id = nextId.current++;
        if (opts.key) keyIds.current.set(opts.key, id);
      }
      const snack: Snack = {
        id,
        key: opts.key,
        text,
        kind,
        action: opts.action,
        duration: "duration" in opts ? (opts.duration ?? null) : defaultDuration(kind, !!opts.action),
        progress: opts.progress,
        rev: 0,
      };
      setQueue((q) => {
        const same = q.findIndex((s) => s.id === snack.id);
        if (same < 0) return [...q, snack];
        const next = [...q];
        next[same] = { ...snack, rev: q[same].rev + 1 };
        return next;
      });
      return { update: (t, o) => patch(id, t, o), dismiss: () => remove(id) };
    },
    [patch, remove],
  );

  // Dev only: lets the mock backend show sample snacks (`?snack=success`).
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __snack?: ShowSnack }).__snack = show;
  }, [show]);

  // Finish the exit animation, then show the next one.
  useEffect(() => {
    if (!leaving) return;
    const id = window.setTimeout(() => {
      setQueue((q) => q.slice(1));
      setLeaving(false);
    }, EXIT_MS);
    return () => window.clearTimeout(id);
  }, [leaving]);

  // Auto-dismiss, paused while hovered/focused or while the window is hidden.
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const remaining = useRef<{ id: number; rev: number; ms: number } | null>(null);
  useEffect(() => {
    if (!current || leaving || current.duration === null) return;
    const r = remaining.current;
    if (!r || r.id !== current.id || r.rev !== current.rev) {
      remaining.current = { id: current.id, rev: current.rev, ms: current.duration };
    }
    if (held || hidden) return;
    const started = Date.now();
    const timer = window.setTimeout(() => remove(current.id), remaining.current!.ms);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current) remaining.current.ms = Math.max(1000, remaining.current.ms - (Date.now() - started));
    };
  }, [current, leaving, held, hidden, remove]);
  useEffect(() => setHeld(false), [current?.id]);

  const bottom = useClearance(!!current);

  return (
    <SnackCtx.Provider value={show}>
      {children}
      <div className="snack-host" style={{ bottom }}>
        {current && (
          <SnackbarView
            key={current.id}
            snack={current}
            leaving={leaving}
            onHold={setHeld}
            onDismiss={() => remove(current.id)}
          />
        )}
      </div>
    </SnackCtx.Provider>
  );
}

function SnackbarView({
  snack,
  leaving,
  onHold,
  onDismiss,
}: {
  snack: Snack;
  leaving: boolean;
  onHold: (held: boolean) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const icon = ICONS[snack.kind];
  // Long text with an action: put the action on its own line (M3 "longer action").
  const stacked = !!snack.action && snack.text.length > 60;
  const determinate = snack.kind === "progress" && typeof snack.progress === "number";
  return (
    <div
      className={["snackbar", snack.kind, stacked ? "stacked" : "", leaving ? "leaving" : ""].join(" ").trim()}
      role={snack.kind === "error" ? "alert" : "status"}
      aria-live={snack.kind === "error" ? "assertive" : "polite"}
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
      onFocus={() => onHold(true)}
      onBlur={() => onHold(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      {icon && <Icon name={icon} fill={snack.kind !== "progress"} className={snack.kind === "progress" ? "snack-icon spin" : "snack-icon"} />}
      <span className="snack-text">{snack.text}</span>
      <span className="snack-actions">
        {snack.action && (
          <Button
            variant="text"
            onClick={() => {
              snack.action?.run();
              onDismiss();
            }}
          >
            {snack.action.label}
          </Button>
        )}
        <IconButton icon="close" label={t("common.close")} small onClick={onDismiss} />
      </span>
      {snack.kind === "progress" && (
        <span
          className={determinate ? "snack-progress" : "snack-progress indeterminate"}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={determinate ? Math.round(snack.progress! * 100) : undefined}
        >
          <span style={determinate ? { width: `${Math.max(0, Math.min(1, snack.progress!)) * 100}%` } : undefined} />
        </span>
      )}
    </div>
  );
}

export function useSnackbar() {
  return useContext(SnackCtx);
}
