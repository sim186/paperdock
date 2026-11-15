// Client-side document handling for printing and importing:
// - load PDFs and images the user picks,
// - lay their pages out on sheets (page range, pages per sheet, rotation,
//   orientation, scaling) into one PDF the printer takes as-is,
// - rasterize pages (to import them into a scanned document, or as a
//   fallback for PDFs pdf-lib can't open).
import { degrees, PDFDocument, PDFEmbeddedPage, PDFImage, rgb } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const PT_PER_MM = 72 / 25.4;

// ------------------------------------------------------------------ sources

export interface SourceDoc {
  id: string;
  name: string;
  kind: "pdf" | "image";
  /** PDF bytes, or JPEG/PNG bytes for an image. */
  bytes: Uint8Array;
  mime: "application/pdf" | "image/jpeg" | "image/png";
  pages: number;
}

let nextId = 1;
const newId = () => `doc${nextId++}`;

export { ACCEPT } from "./files";

export class UnsupportedFile extends Error {
  constructor(public fileName: string) {
    super(`unsupported file: ${fileName}`);
  }
}

function isPdf(b: Uint8Array) {
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
}
function isJpeg(b: Uint8Array) {
  return b[0] === 0xff && b[1] === 0xd8;
}
function isPng(b: Uint8Array) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // decode() has the pixels; the URL isn't needed any more
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasToBytes(canvas: HTMLCanvasElement, type: "image/jpeg" | "image/png", quality = 0.9) {
  return new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("encode failed"))),
      type,
      quality,
    ),
  );
}

/** Any image the webview can decode, re-encoded as PNG. */
async function toPng(blob: Blob): Promise<Uint8Array> {
  const img = await loadImage(blob);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  return canvasToBytes(c, "image/png");
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  try {
    const d = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return d.getPageCount();
  } catch {
    const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const n = d.numPages;
    await d.destroy();
    return n;
  }
}

export async function loadFile(file: File): Promise<SourceDoc> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return fromBytes(file.name, bytes, file);
}

export async function fromBytes(name: string, bytes: Uint8Array, blob?: Blob): Promise<SourceDoc> {
  if (isPdf(bytes)) {
    return { id: newId(), name, kind: "pdf", bytes, mime: "application/pdf", pages: await pdfPageCount(bytes) };
  }
  if (isJpeg(bytes)) return { id: newId(), name, kind: "image", bytes, mime: "image/jpeg", pages: 1 };
  if (isPng(bytes)) return { id: newId(), name, kind: "image", bytes, mime: "image/png", pages: 1 };
  try {
    const png = await toPng(blob ?? new Blob([bytes.slice()]));
    return { id: newId(), name, kind: "image", bytes: png, mime: "image/png", pages: 1 };
  } catch {
    throw new UnsupportedFile(name);
  }
}

// ------------------------------------------------------------------ ranges

/**
 * "1-3, 5, 8-" -> [1,2,3,5,8,...,total] (1-based, in the order written).
 * Empty means all pages. Returns null when the text can't be parsed or
 * selects nothing.
 */
export function parseRange(text: string, total: number): number[] | null {
  const t = text.trim();
  if (!t) return Array.from({ length: total }, (_, i) => i + 1);
  const out: number[] = [];
  for (const part of t.split(/[,;]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(p);
    if (m) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : total;
      if (a < 1 || b < 1) return null;
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) if (i <= total) out.push(i);
    } else if (/^\d+$/.test(p)) {
      const n = +p;
      if (n < 1) return null;
      if (n <= total) out.push(n);
    } else {
      return null;
    }
  }
  return out.length ? out : null;
}

// ------------------------------------------------------------------ paper

export interface Paper {
  /** IPP media name, sent to the printer. */
  media: string;
  label: string;
  /** Portrait size in points. */
  w: number;
  h: number;
}

const FRIENDLY: Record<string, string> = {
  iso_a3: "A3",
  iso_a4: "A4",
  iso_a5: "A5",
  iso_a6: "A6",
  iso_b5: "B5",
  jis_b5: "B5 (JIS)",
  na_letter: "Letter",
  na_legal: "Legal",
  na_executive: "Executive",
  na_foolscap: "Foolscap",
};

/** Paper sizes from IPP media names, common ones first. */
export function papersFrom(media: string[]): Paper[] {
  const out: Paper[] = [];
  for (const m of media) {
    if (m.startsWith("custom_")) continue;
    const dims = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|in)$/.exec(m);
    if (!dims) continue;
    const unit = dims[3] === "mm" ? PT_PER_MM : 72;
    const w = +dims[1] * unit;
    const h = +dims[2] * unit;
    const key = m.slice(0, m.indexOf("_", m.indexOf("_") + 1));
    const friendly = FRIENDLY[key];
    if (!friendly) continue; // envelopes, photo and index cards: not for documents
    out.push({ media: m, label: friendly, w: Math.min(w, h), h: Math.max(w, h) });
  }
  const order = Object.values(FRIENDLY);
  return out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

export const A4: Paper = { media: "iso_a4_210x297mm", label: "A4", w: 210 * PT_PER_MM, h: 297 * PT_PER_MM };

// ------------------------------------------------------------------ layout

export type PerSheet = 1 | 2 | 4 | 6 | 9 | 16;
export type Orientation = "auto" | "portrait" | "landscape";
export type Rotation = 0 | 90 | 180 | 270;

export interface Layout {
  /** Page selection over all documents together, e.g. "1-3, 5". */
  range: string;
  /** Print each selected page this many times in a row (e.g. 4 tickets on a sheet). */
  repeat?: number;
  perSheet: PerSheet;
  orientation: Orientation;
  /** Extra clockwise rotation for every page. */
  rotate: Rotation;
  /** Scale pages to the sheet (else 100%, centered). */
  fit: boolean;
  borders: boolean;
  paper: Paper;
}

const GRID: Record<PerSheet, [number, number]> = {
  // [columns, rows] on a portrait sheet
  1: [1, 1],
  2: [1, 2],
  4: [2, 2],
  6: [2, 3],
  9: [3, 3],
  16: [4, 4],
};

/** Hardware margins are ~4.2 mm on most lasers; stay clear of them. */
const MARGIN = 6 * PT_PER_MM;
const GAP = 4 * PT_PER_MM;

interface Item {
  draw: PDFEmbeddedPage | PDFImage;
  /** Natural size in points, before any rotation. */
  w: number;
  h: number;
  /** Clockwise rotation already in the source (/Rotate). */
  rot: number;
}

/** Where an item lands, in the sheet's own (possibly landscape) frame. */
export interface Placement {
  cx: number;
  cy: number;
  cellW: number;
  cellH: number;
}

/** Sheet frame and cells for a layout. Landscape frames are turned onto portrait paper when drawn. */
export function sheetFrame(layout: Layout, firstLandscape: boolean) {
  const [c, r] = GRID[layout.perSheet];
  // Two and six per sheet read naturally on a landscape sheet.
  const naturalLandscape = layout.perSheet === 2 || layout.perSheet === 6;
  const landscape =
    layout.orientation === "landscape" ||
    (layout.orientation === "auto" && (layout.perSheet === 1 ? firstLandscape : naturalLandscape));
  // The grid turns with the sheet: two-up is stacked on portrait, side by side on landscape.
  const [cols2, rows2] = landscape ? [r, c] : [c, r];
  const W = landscape ? layout.paper.h : layout.paper.w;
  const H = landscape ? layout.paper.w : layout.paper.h;
  const cellW = (W - 2 * MARGIN - (cols2 - 1) * GAP) / cols2;
  const cellH = (H - 2 * MARGIN - (rows2 - 1) * GAP) / rows2;
  const cells: Placement[] = [];
  for (let y = 0; y < rows2; y++)
    for (let x = 0; x < cols2; x++)
      cells.push({
        cx: MARGIN + x * (cellW + GAP) + cellW / 2,
        // PDF y grows upwards: first row at the top
        cy: H - MARGIN - y * (cellH + GAP) - cellH / 2,
        cellW,
        cellH,
      });
  return { landscape, W, H, cells };
}

async function collectItems(out: PDFDocument, docs: SourceDoc[]): Promise<Item[]> {
  const items: Item[] = [];
  for (const d of docs) {
    if (d.kind === "image") {
      const img = d.mime === "image/png" ? await out.embedPng(d.bytes) : await out.embedJpg(d.bytes);
      // Images have no physical size; assume 150 dpi for "actual size".
      items.push({ draw: img, w: (img.width * 72) / 150, h: (img.height * 72) / 150, rot: 0 });
      continue;
    }
    let src: PDFDocument | null = null;
    try {
      src = await PDFDocument.load(d.bytes, { ignoreEncryption: false, updateMetadata: false });
    } catch {
      src = null;
    }
    if (src) {
      const pages = src.getPages();
      // Only the visible area (CropBox) — the rest of the MediaBox would
      // show as an empty strip next to the page.
      const boxes = pages.map((pg) => {
        const m = pg.getMediaBox();
        const c = pg.getCropBox();
        const left = Math.max(m.x, c.x);
        const bottom = Math.max(m.y, c.y);
        const right = Math.min(m.x + m.width, c.x + c.width);
        const top = Math.min(m.y + m.height, c.y + c.height);
        return right > left && top > bottom ? { left, bottom, right, top } : undefined;
      });
      const embedded = await out.embedPages(pages, boxes);
      embedded.forEach((e, i) => {
        items.push({ draw: e, w: e.width, h: e.height, rot: ((pages[i].getRotation().angle % 360) + 360) % 360 });
      });
    } else {
      // Encrypted or unusual PDFs: print a rendering of each page.
      for (const jpg of await rasterize(d.bytes, 200)) {
        const img = await out.embedJpg(jpg.bytes);
        items.push({ draw: img, w: (img.width * 72) / 200, h: (img.height * 72) / 200, rot: 0 });
      }
    }
  }
  return items;
}

/** Total pages over all documents. */
export const totalPages = (docs: SourceDoc[]) => docs.reduce((n, d) => n + d.pages, 0);

export interface Composed {
  pdf: Uint8Array;
  sheets: number;
  /** Printed pages selected by the range. */
  pages: number;
}

/**
 * Lay the selected pages out on sheets. Every output page is portrait paper
 * (landscape layouts are turned on it) so printers never need to auto-rotate.
 */
export async function compose(docs: SourceDoc[], layout: Layout): Promise<Composed> {
  const out = await PDFDocument.create();
  out.setProducer("PaperDock");
  out.setCreator("PaperDock");
  const all = await collectItems(out, docs);
  const picked = parseRange(layout.range, all.length) ?? [];
  const repeat = Math.max(1, Math.floor(layout.repeat ?? 1));
  const items = picked.flatMap((n) => Array<Item>(repeat).fill(all[n - 1]));
  const userCw = layout.rotate;

  // Effective clockwise rotation of an item, before auto-fitting.
  const baseCw = (it: Item) => (it.rot + userCw) % 360;
  const isLandscape = (it: Item) => {
    const cw = baseCw(it);
    const [w, h] = cw % 180 ? [it.h, it.w] : [it.w, it.h];
    return w > h;
  };

  const frame = sheetFrame(layout, items.length > 0 && isLandscape(items[0]));
  const per = frame.cells.length;
  const { w: PW, h: PH } = layout.paper;

  for (let s = 0; s < items.length; s += per) {
    const page = out.addPage([PW, PH]);
    // One-up auto: each sheet follows its own page's orientation.
    const f =
      layout.perSheet === 1 && layout.orientation === "auto" ? sheetFrame(layout, isLandscape(items[s])) : frame;
    items.slice(s, s + per).forEach((it, i) => {
      const cell = f.cells[i];
      let cw = baseCw(it);
      let [w, h] = cw % 180 ? [it.h, it.w] : [it.w, it.h];
      // Auto: turn pages that fit their cell better the other way.
      if (layout.orientation === "auto" && layout.perSheet > 1 && w > h !== cell.cellW > cell.cellH) {
        // Turn whichever way brings it upright, else the usual landscape turn (top to the left).
        cw = (cw + 90) % 360 === 0 ? 0 : (cw + 270) % 360;
        [w, h] = [h, w];
      }
      const fit = Math.min(cell.cellW / w, cell.cellH / h);
      const scale = layout.fit || layout.perSheet > 1 ? fit : 1;
      const sw = it.w * scale;
      const sh = it.h * scale;
      // pdf-lib rotates counter-clockwise about the anchor (lower-left corner).
      let ccw = (360 - cw) % 360;
      const bw = ccw % 180 ? sh : sw;
      const bh = ccw % 180 ? sw : sh;
      const minX = ccw === 90 ? -sh : ccw === 180 ? -sw : 0;
      const minY = ccw === 180 ? -sh : ccw === 270 ? -sw : 0;
      let x = cell.cx - bw / 2 - minX;
      let y = cell.cy - bh / 2 - minY;
      let bx = cell.cx - bw / 2;
      let by = cell.cy - bh / 2;
      let bW = bw;
      let bH = bh;
      if (f.landscape) {
        // Landscape frame onto portrait paper: turn 90° counter-clockwise.
        [x, y] = [PW - y, x];
        [bx, by, bW, bH] = [PW - by - bh, bx, bh, bw];
        ccw = (ccw + 90) % 360;
      }
      const opts = { x, y, xScale: scale, yScale: scale, rotate: degrees(ccw) };
      if (it.draw instanceof PDFImage) {
        page.drawImage(it.draw, { x, y, width: sw, height: sh, rotate: degrees(ccw) });
      } else {
        page.drawPage(it.draw, opts);
      }
      if (layout.borders && layout.perSheet > 1) {
        page.drawRectangle({ x: bx, y: by, width: bW, height: bH, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
      }
    });
  }
  const pdf = await out.save();
  return { pdf, sheets: out.getPageCount(), pages: items.length };
}

/**
 * Split printed sides for manual two-sided printing: fronts are sides
 * 1,3,5…; backs are 2,4,6… (a blank side pads an odd count). Backs are
 * reversed by default because the printed stack comes out last sheet on top.
 */
export async function splitForManualDuplex(pdf: Uint8Array, copies: number, reverseBacks: boolean) {
  const src = await PDFDocument.load(pdf);
  const n = src.getPageCount();
  const sides: (number | null)[] = [];
  for (let c = 0; c < copies; c++) {
    for (let i = 0; i < n; i++) sides.push(i);
    if (n % 2) sides.push(null); // each copy starts on a new sheet
  }
  const fronts = sides.filter((_, i) => i % 2 === 0);
  let backs = sides.filter((_, i) => i % 2 === 1);
  if (reverseBacks) backs = backs.reverse();
  const [w, h] = (() => {
    const p = src.getPage(0).getSize();
    return [p.width, p.height];
  })();
  const build = async (list: (number | null)[]) => {
    const d = await PDFDocument.create();
    for (const i of list) {
      if (i === null) d.addPage([w, h]);
      else d.addPage((await d.copyPages(src, [i]))[0]);
    }
    return d.save();
  };
  return { fronts: await build(fronts), backs: await build(backs), sheets: fronts.length };
}

// ------------------------------------------------------------------ rendering

/** Render PDF pages to JPEG. `pages` are 1-based; all when omitted. */
export async function rasterize(
  bytes: Uint8Array,
  dpi: number,
  pages?: number[],
  quality = 0.88,
): Promise<{ bytes: Uint8Array; width: number; height: number }[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    const list = pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const out = [];
    for (const n of list) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push({ bytes: await canvasToBytes(c, "image/jpeg", quality), width: c.width, height: c.height });
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** Small previews of the first `max` pages, as object URLs (caller revokes). */
export async function thumbnails(bytes: Uint8Array, width: number, max: number): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    const urls: string[] = [];
    for (let n = 1; n <= Math.min(max, doc.numPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width * window.devicePixelRatio) / base.width });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const b = await canvasToBytes(c, "image/jpeg", 0.8);
      urls.push(URL.createObjectURL(new Blob([b.slice()], { type: "image/jpeg" })));
      page.cleanup();
    }
    return urls;
  } finally {
    await doc.destroy();
  }
}

/**
 * Pages of a file as JPEG/PNG images for a scanned document: PDFs are
 * rendered at `dpi`, JPEG/PNG pass through, other images become PNG.
 */
export async function filePagesAsImages(file: File, dpi: number): Promise<Uint8Array[]> {
  const doc = await loadFile(file);
  if (doc.kind === "image") return [doc.bytes];
  return (await rasterize(doc.bytes, dpi)).map((p) => p.bytes);
}

/**
 * The same sheets as pictures: each page rendered at `dpi` and wrapped in a
 * plain PDF (one JPEG per page, classic xref). Old printer firmware that
 * aborts on modern PDFs (transparency, embedded fonts, object streams)
 * prints these like a scan.
 */
export async function flattenForPrint(pdf: Uint8Array, dpi?: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdf);
  // ~2 MB a page at 300 dpi: long documents go at 200 to stay quick to send.
  dpi ??= src.getPageCount() > 10 ? 200 : 300;
  const sizes = src.getPages().map((p) => p.getSize());
  const out = await PDFDocument.create();
  out.setProducer("PaperDock");
  const images = await rasterize(pdf, dpi, undefined, 0.9);
  for (let i = 0; i < images.length; i++) {
    const { width, height } = sizes[i];
    const img = await out.embedJpg(images[i].bytes);
    out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
  }
  return out.save({ useObjectStreams: false });
}
