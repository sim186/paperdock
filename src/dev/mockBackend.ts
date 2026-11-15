// Dev only: a fake Rust backend for `npm run dev` in a normal browser.
// Loaded from main.tsx when there is no Tauri runtime; never part of a build.
// Add `?empty` to the URL to see the first-run screen.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { PageView, SessionView } from "../api";

// `?tab=scan` opens a tab, `?pages` starts with a scanned document, `?flip` mid manual duplex.
const q = new URLSearchParams(location.search);
if (q.has("empty")) localStorage.clear();
if (!q.has("empty") && !localStorage.getItem("device"))
  localStorage.setItem("device", JSON.stringify({ host: "192.168.1.84", name: "HP LaserJet 200 colorMFP M276n", hints: {} }));
if (q.get("tab")) localStorage.setItem("tab", q.get("tab")!);
if (q.get("lang")) localStorage.setItem("lang", q.get("lang")!);

// `?snack=info|success|warning|error|progress|long|queue` shows sample snackbars.
const SAMPLES: Record<string, [string, Record<string, unknown>][]> = {
  info: [["Copied serial number", {}]],
  success: [["Printed · report.pdf", { kind: "success" }]],
  warning: [["The printer refused the PDF: sending pages as pictures", { kind: "warning" }]],
  error: [["The printer threw the job away without printing", { kind: "error" }]],
  progress: [["Printing on HP LaserJet M276n · report.pdf", { kind: "progress", progress: 0.62 }]],
  action: [["Saved scan-2026-11-15.pdf", { kind: "success", action: { label: "Show", run: () => {} } }]],
  long: [
    [
      "3 blank pages were left out of the document. You can turn blank page removal off in the scan settings.",
      { action: { label: "Settings", run: () => {} } },
    ],
  ],
};
// `&bare` hides the app behind the snackbar (for README screenshots).
if (q.has("bare")) document.head.insertAdjacentHTML("beforeend", "<style>.app{visibility:hidden}</style>");
const sample = q.get("snack");
if (sample && SAMPLES[sample]) {
  const fire = () => {
    const show = (window as unknown as { __snack?: (t: string, o: object) => void }).__snack;
    if (!show) return void setTimeout(fire, 50);
    for (const [text, opts] of SAMPLES[sample]) show(text, { ...opts, duration: null });
  };
  setTimeout(fire, 300);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sheet(seed: number, blank = false) {
  const lines = blank
    ? ""
    : Array.from({ length: 14 }, (_, i) => {
        const w = 120 + ((seed * 37 + i * 53) % 60);
        return `<rect x="24" y="${70 + i * 14}" width="${i % 5 === 4 ? w / 2 : w}" height="5" rx="2" fill="#9aa"/>`;
      }).join("");
  const head = blank ? "" : `<rect x="24" y="28" width="90" height="12" rx="2" fill="#345"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="210" height="297"><rect width="210" height="297" fill="#fff"/>${head}${lines}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

let nextId = 1;
let pages: PageView[] = [];
let awaitingBacks: number | null = null;
let jobCounter = 0;
let scanProgress: { phase: string; pages: number } | null = null;
const view = (): SessionView => ({ pages, awaitingBacks });
if (q.has("pages") || q.has("flip")) {
  pages = Array.from({ length: 6 }, (_, i) => ({ id: nextId++, rotation: i === 4 ? 90 : 0, thumb: sheet(i, i === 3), blank: i === 3 }));
  if (q.has("flip")) awaitingBacks = 6;
}

const accounts = [
  {
    id: "1",
    displayName: "Ufficio",
    emailAddress: "scanner@studio-example.it",
    smtpServer: "smtps.aruba.it",
    port: 465,
    maxAttachmentSize: 10,
    useSsl: true,
    ccToSelf: false,
    username: "scanner@studio-example.it",
    password: null,
    pin: null,
  },
  {
    id: "2",
    displayName: "Personale",
    emailAddress: "me@example.com",
    smtpServer: "smtp.gmail.com",
    port: 465,
    maxAttachmentSize: 0,
    useSsl: true,
    ccToSelf: true,
    username: "me@example.com",
    password: null,
    pin: null,
  },
];

let s2e = {
  enabled: true,
  defaultBodyEnabled: true,
  subject: "Scansione",
  body: "Documento scansionato in allegato.",
  mediaSize: "a4",
  color: "color",
  fileType: "pdf",
  resolution: "300dpi",
  fileNamePrefix: "scan",
};

mockIPC(
  async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "system_locale":
        return "en-US";
      case "discover_printers":
        await wait(1500);
        return [
          {
            host: "NPI3F2A1C.local",
            name: "HP LaserJet 200 colorMFP M276n",
            addresses: ["192.168.1.84"],
            scanner: true,
            printer: true,
            esclRoot: "eSCL",
            ippResource: "ipp/print",
          },
          {
            host: "DeskJet-3700.local",
            name: "HP DeskJet 3700 series",
            addresses: ["192.168.1.52"],
            scanner: true,
            printer: true,
            esclRoot: "eSCL",
            ippResource: "ipp/print",
          },
        ];
      case "probe_device":
        await wait(700);
        return {
          model: "HP LaserJet 200 colorMFP M276n",
          features: { ipp: true, escl: false, wsscan: true, ledm: true, emailProfiles: true },
          scanProtocol: "wsscan",
          wsscanUrl: "http://192.168.1.84:3910/",
        };
      case "device_overview":
        // `?slow` keeps the printer silent for 20 s (waiting states of the overview).
        await wait(q.has("slow") ? 20000 : 400);
        return {
          model: "HP LaserJet 200 colorMFP M276n",
          state: "idle",
          stateMessage: null,
          alerts: [{ id: "tonerLow", message: null, severity: "warning", color: "Magenta" }],
          supplies: [
            { name: "Black", code: "K", color: null, level: 62, partNumber: "131X (CF210X)", estimatedPages: 1000, state: null },
            { name: "Cyan", code: "C", color: null, level: 41, partNumber: "131A (CF211A)", estimatedPages: 720, state: null },
            { name: "Magenta", code: "M", color: null, level: 8, partNumber: "131A (CF213A)", estimatedPages: 90, state: "low" },
            { name: "Yellow", code: "Y", color: null, level: 77, partNumber: "131A (CF212A)", estimatedPages: 1300, state: null },
          ],
          serialNumber: "CNF8BCK0QZ",
          productNumber: "CF145A",
          firmwareDate: "20200612",
          location: "Studio, primo piano",
          color: true,
          duplexPrint: false,
        };
      case "scanner_info":
        return [
          {
            makeAndModel: "HP LaserJet 200 colorMFP M276n",
            namespace: "",
            version: "2.0",
            colorModes: ["RGB24", "Grayscale8"],
            platen: { maxWidth: 2550, maxHeight: 3508, resolutions: [75, 100, 150, 200, 300, 600] },
            adf: { maxWidth: 2550, maxHeight: 4200, resolutions: [75, 100, 150, 200, 300] },
            adfDuplex: false,
            adfCapacity: 35,
          },
          { state: "Idle", adfState: "ScannerAdfLoaded" },
        ];
      case "scanner_status":
        return { state: "Idle", adfState: "ScannerAdfLoaded" };
      case "session_get":
        return view();
      case "scan_status":
        return scanProgress;
      case "session_scan": {
        const { emit } = await import("@tauri-apps/api/event");
        const mode = a.mode as string;
        const n = mode === "backs" ? awaitingBacks ?? 0 : 4;
        for (let i = 0; i <= n; i++) {
          scanProgress = { phase: "scanning", pages: i };
          await emit("scan-progress", scanProgress);
          await wait(q.has("slow") ? 1500 : 300);
        }
        const fresh = Array.from({ length: n }, (_, i) => ({
          id: nextId++,
          rotation: 0,
          thumb: sheet(nextId + i, i === 2),
          blank: i === 2,
        }));
        pages = [...pages, ...fresh];
        awaitingBacks = mode === "fronts" ? n : null;
        scanProgress = null;
        await emit("scan-finished", { session: view(), error: null });
        return view();
      }
      case "session_finish_fronts":
        awaitingBacks = null;
        return view();
      case "session_rotate":
        pages = pages.map((p) => (p.id === a.id ? { ...p, rotation: (p.rotation + 90) % 360 } : p));
        return view();
      case "session_delete":
        pages = pages.filter((p) => p.id !== a.id);
        return view();
      case "session_delete_blank":
        pages = pages.filter((p) => !p.blank);
        return view();
      case "session_move": {
        const i = pages.findIndex((p) => p.id === a.id);
        const [p] = pages.splice(i, 1);
        pages.splice(a.to as number, 0, p);
        pages = [...pages];
        return view();
      }
      case "session_clear":
        pages = [];
        awaitingBacks = null;
        return view();
      case "session_save":
        await wait(500);
        return [a.path as string];
      case "scan_cancel":
        return null;
      case "session_import": {
        await wait(150);
        const bytes = args as unknown as Uint8Array;
        const blob = new Blob([bytes.slice()], { type: bytes[0] === 0x89 ? "image/png" : "image/jpeg" });
        pages = [...pages, { id: nextId++, rotation: 0, thumb: URL.createObjectURL(blob), blank: false }];
        return view();
      }
      case "session_page": {
        // The mock thumbs are SVG/blob URLs: hand back their bytes.
        const page = pages.find((p) => p.id === a.id);
        return page ? await (await fetch(page.thumb)).arrayBuffer() : null;
      }
      case "session_pdf": {
        const { PDFDocument, rgb } = await import("pdf-lib");
        const doc = await PDFDocument.create();
        pages.forEach((_, i) => {
          const pg = doc.addPage([595, 842]);
          pg.drawRectangle({ x: 60, y: 760, width: 200, height: 24, color: rgb(0.2, 0.27, 0.33) });
          for (let l = 0; l < 30; l++)
            pg.drawRectangle({ x: 60, y: 700 - l * 20, width: 300 + ((i * 37 + l * 53) % 160), height: 8, color: rgb(0.6, 0.67, 0.67) });
        });
        return (await doc.save()).buffer;
      }
      case "print_caps":
        await wait(300);
        return {
          resource: "ipp/print",
          pdf: true,
          color: true,
          colorModes: ["auto", "monochrome", "color"],
          sides: q.has("duplex") ? ["one-sided", "two-sided-long-edge", "two-sided-short-edge"] : ["one-sided"],
          media: ["na_letter_8.5x11in", "na_legal_8.5x14in", "iso_a4_210x297mm", "iso_a5_148x210mm", "custom_max_8.5x14in"],
          mediaDefault: "iso_a4_210x297mm",
          copiesMax: 999,
        };
      case "print_job_status": {
        // `?abort`: the printer throws the first job away, like the M276n with some PDFs.
        const aborted = q.has("abort") && a.jobId === 42;
        return { state: aborted ? 8 : 9, reasons: [aborted ? "aborted-by-system" : "none"], sheets: aborted ? 0 : 1 };
      }
      case "print_document": {
        await wait(1200);
        jobCounter++;
        const bytes = args as unknown as Uint8Array;
        (window as unknown as { __printed: unknown[] }).__printed ??= [];
        (window as unknown as { __printed: unknown[] }).__printed.push({ size: bytes.length, options: a });
        console.log("[mock] print", bytes.length, "bytes");
        return 41 + jobCounter;
      }
      case "email_accounts":
        await wait(300);
        return accounts;
      case "email_account_test":
        await wait(1200);
        return "Success";
      case "email_account_save":
      case "email_account_delete":
        await wait(400);
        return null;
      case "scan_to_email_get":
        await wait(300);
        return {
          settings: { ...s2e },
          options: {
            mediaSizes: ["a4", "letter", "legal"],
            colors: ["color", "grayscale"],
            fileTypes: ["pdf", "jpeg"],
            resolutions: ["75dpi", "150dpi", "200dpi", "300dpi"],
            subjectMax: 50,
            bodyMax: 200,
            prefixMax: 16,
          },
        };
      case "scan_to_email_set":
        await wait(400);
        s2e = { ...(a.settings as typeof s2e) };
        return null;
      case "plugin:dialog|save":
        return "/Users/demo/Documents/scan.pdf";
      case "plugin:opener|reveal_item_in_dir":
        return null;
      default:
        console.warn("[mock] unhandled", cmd, args);
        return null;
    }
  },
  { shouldMockEvents: true },
);
