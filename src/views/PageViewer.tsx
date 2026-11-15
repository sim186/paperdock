import { useEffect, useRef, useState } from "react";
import { api, PageView } from "../api";
import { IconButton } from "../components";
import { useI18n } from "../i18n";

const MIN = 1;
const MAX = 8;
const STEP = 1.25;

interface View {
  /** 1 = whole page fits the window. */
  scale: number;
  /** Offset of the page center from the stage center, in screen pixels. */
  x: number;
  y: number;
}
const FIT: View = { scale: 1, x: 0, y: 0 };

/** Zoom to `scale` keeping the point (px, py) — relative to the stage center — still. */
function zoomAt(v: View, scale: number, px: number, py: number): View {
  const s = Math.min(MAX, Math.max(MIN, scale));
  if (s === MIN) return FIT;
  const k = s / v.scale;
  return { scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

function mimeOf(b: Uint8Array) {
  if (b[0] === 0x89) return "image/png";
  if (b[0] === 0x3c) return "image/svg+xml"; // dev mock pages
  return "image/jpeg";
}

/**
 * Full-window view of the scanned pages. The thumbnail shows at once and is
 * swapped for the full-size scan when it arrives.
 * Zoom: mouse wheel (toward the pointer), + / − buttons or keys, 0 to fit;
 * drag to move a zoomed page, click to zoom in / back to fit.
 * Keys: ←/→ page, R rotate, Delete remove, Esc close.
 */
export default function PageViewer({
  pages,
  index,
  busy,
  onIndex,
  onClose,
  onRotate,
  onDelete,
}: {
  pages: PageView[];
  index: number;
  busy: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
  onRotate: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const { t } = useI18n();
  const page = pages[index];
  const [full, setFull] = useState<Record<number, string>>({});
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const zoomed = view.scale > 1;

  /** Pointer position relative to the stage center. */
  const fromCenter = (clientX: number, clientY: number) => {
    const r = stage.current!.getBoundingClientRect();
    return [clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2)] as const;
  };
  const zoomBy = (factor: number) => setView((v) => zoomAt(v, v.scale * factor, 0, 0));
  const urls = useRef<string[]>([]);
  const root = useRef<HTMLDivElement>(null);

  // Load the full-size image of the current page (and keep it for paging back).
  useEffect(() => {
    if (!page || full[page.id]) return;
    let gone = false;
    api
      .sessionPage(page.id)
      .then((bytes) => {
        if (gone) return;
        const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mimeOf(bytes) }));
        urls.current.push(url);
        setFull((f) => ({ ...f, [page.id]: url }));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [page, full]);

  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);
  // Focus the close button so Esc/Enter work at once.
  useEffect(() => root.current?.querySelector<HTMLButtonElement>(".viewer-close")?.focus(), []);
  useEffect(() => setView(FIT), [index]);

  // Wheel zoom. Registered by hand: React's wheel listener is passive and
  // can't stop the page from scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpad pinch arrives as small ctrl+wheel steps; mouse wheels as big ones.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      const [px, py] = fromCenter(e.clientX, e.clientY);
      setView((v) => zoomAt(v, v.scale * factor, px, py));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  // The last page was deleted: close.
  useEffect(() => {
    if (!page) onClose();
  }, [page, onClose]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < pages.length - 1) onIndex(index + 1);
      else if ((e.key === "r" || e.key === "R") && page && !busy) onRotate(page.id);
      else if ((e.key === "Delete" || e.key === "Backspace") && page && !busy) onDelete(page.id);
      else if (e.key === "+" || e.key === "=") zoomBy(STEP);
      else if (e.key === "-") zoomBy(1 / STEP);
      else if (e.key === "0") setView(FIT);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, pages.length, page, busy, onClose, onIndex, onRotate, onDelete]);

  if (!page) return null;
  const sideways = page.rotation % 180 !== 0;
  const src = full[page.id] ?? page.thumb;

  return (
    <div ref={root} className="viewer" role="dialog" aria-modal="true" aria-label={t("scan.pageN", { n: index + 1 })}>
      <div className="viewer-bar">
        <span className="title-m grow">{t("scan.pageOf", { n: index + 1, total: pages.length })}</span>
        <div className="viewer-zoom" role="group" aria-label={t("scan.zoom")}>
          <IconButton icon="remove" label={t("scan.zoomOut")} onClick={() => zoomBy(1 / STEP)} disabled={!zoomed} />
          <button
            type="button"
            className="viewer-zoom-value"
            onClick={() => setView(FIT)}
            title={t("scan.fit")}
            disabled={!zoomed}
          >
            {Math.round(view.scale * 100)}%
          </button>
          <IconButton icon="add" label={t("scan.zoomIn")} onClick={() => zoomBy(STEP)} disabled={view.scale >= MAX} />
        </div>
        <IconButton icon="rotate_right" label={t("scan.rotate")} onClick={() => onRotate(page.id)} disabled={busy} />
        <IconButton
          icon="delete"
          className="delete"
          label={t("scan.removePage")}
          onClick={() => onDelete(page.id)}
          disabled={busy}
        />
        <IconButton className="viewer-close" icon="close" label={t("common.close")} onClick={onClose} />
      </div>

      <div
        ref={stage}
        className={["viewer-stage", zoomed ? "zoomed" : "", dragging ? "dragging" : ""].join(" ").trim()}
        onClick={(e) => {
          // a click on the dark area closes, like the dialogs
          if (e.target === e.currentTarget && !zoomed && !drag.current?.moved) onClose();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          if (!d.moved) {
            d.moved = true;
            setDragging(true);
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          if (zoomed) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={() => {
          setDragging(false);
          // keep `moved` until the click that follows, then forget the drag
          setTimeout(() => (drag.current = null), 0);
        }}
      >
        <img
          src={src}
          alt={t("scan.pageN", { n: index + 1 })}
          className={sideways ? "sideways" : undefined}
          style={{
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale}) rotate(${page.rotation}deg)`,
          }}
          onClick={(e) => {
            if (drag.current?.moved) return;
            const [px, py] = fromCenter(e.clientX, e.clientY);
            setView((v) => (v.scale > 1 ? FIT : zoomAt(v, 2.5, px, py)));
          }}
          draggable={false}
        />
      </div>

      <IconButton
        className="viewer-nav prev"
        icon="chevron_left"
        label={t("scan.previous")}
        disabled={index === 0}
        onClick={() => onIndex(index - 1)}
      />
      <IconButton
        className="viewer-nav next"
        icon="chevron_right"
        label={t("scan.next")}
        disabled={index === pages.length - 1}
        onClick={() => onIndex(index + 1)}
      />
    </div>
  );
}
