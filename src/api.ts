import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------- errors

/** Shape of every error coming from Rust (see src-tauri/src/error.rs). */
export interface AppError {
  code: string;
  message: string;
  params: Record<string, string>;
}

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e) return e as AppError;
  const message = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
  return { code: "unknown", message, params: {} };
}

// --------------------------------------------------------------- devices

export interface Hints {
  esclRoot?: string | null;
  ippResource?: string | null;
  scanProtocol?: string | null;
  wsscanUrl?: string | null;
}

export interface Discovered {
  host: string;
  name: string;
  addresses: string[];
  scanner: boolean;
  printer: boolean;
  esclRoot: string | null;
  ippResource: string | null;
}

export interface Features {
  ipp: boolean;
  escl: boolean;
  wsscan: boolean;
  ledm: boolean;
  emailProfiles: boolean;
}

export interface DeviceProfile {
  model: string | null;
  features: Features;
  scanProtocol: "escl" | "wsscan" | null;
  wsscanUrl: string | null;
}

/** A device the user picked, persisted between runs. */
export interface Device {
  host: string;
  name?: string;
  hints: Hints;
}

export interface Supply {
  name: string;
  code: string | null;
  color: string | null;
  level: number | null;
  partNumber: string | null;
  estimatedPages: number | null;
  state: string | null;
}

export interface Alert {
  id: string | null;
  message: string | null;
  severity: string | null;
  color: string | null;
}

export interface Overview {
  model: string | null;
  state: string | null;
  stateMessage: string | null;
  alerts: Alert[];
  supplies: Supply[];
  serialNumber: string | null;
  productNumber: string | null;
  firmwareDate: string | null;
  location: string | null;
  color: boolean | null;
  duplexPrint: boolean | null;
}

// ----------------------------------------------------- HP email profiles

export interface EmailAccount {
  id: string | null;
  displayName: string;
  emailAddress: string;
  smtpServer: string;
  port: number;
  maxAttachmentSize: number;
  useSsl: boolean;
  ccToSelf: boolean;
  username: string | null;
  /** Write-only: null on update keeps the stored password. */
  password: string | null;
  pin: string | null;
}

export interface ScanToEmailSettings {
  enabled: boolean;
  defaultBodyEnabled: boolean;
  subject: string;
  body: string;
  mediaSize: string;
  color: string;
  fileType: string;
  resolution: string;
  fileNamePrefix: string;
}

export interface ScanToEmailConfig {
  settings: ScanToEmailSettings;
  options: {
    mediaSizes: string[];
    colors: string[];
    fileTypes: string[];
    resolutions: string[];
    subjectMax: number;
    bodyMax: number;
    prefixMax: number;
  };
}

// --------------------------------------------------------------- scanning

export interface InputCaps {
  maxWidth: number;
  maxHeight: number;
  resolutions: number[];
}

export interface ScannerCaps {
  makeAndModel: string | null;
  namespace: string;
  version: string;
  colorModes: string[];
  platen: InputCaps | null;
  adf: InputCaps | null;
  adfDuplex: boolean;
  adfCapacity: number | null;
}

export interface ScannerStatus {
  state: string;
  adfState: string | null;
}

export type Source = "Platen" | "Feeder";
export type Paper = "a4" | "letter" | "legal" | "max";
export type BatchMode = "append" | "fronts" | "backs";

export interface ScanRequest {
  source: Source;
  colorMode: string;
  resolution: number;
  paper: Paper;
  duplex: boolean;
}

export interface PageView {
  id: number;
  rotation: number;
  thumb: string;
  blank: boolean;
}

export interface SessionView {
  pages: PageView[];
  awaitingBacks: number | null;
  /** Blank pages the last scan left out. */
  skippedBlank?: number;
}

export interface ScanFinished {
  session: SessionView | null;
  error: AppError | null;
}

export interface ScanProgress {
  phase: "scanning" | "processing";
  pages: number;
}

export interface PrintCaps {
  resource: string;
  pdf: boolean;
  color: boolean;
  colorModes: string[];
  sides: string[];
  media: string[];
  mediaDefault: string | null;
  copiesMax: number;
}

export interface JobStatus {
  /** IPP job-state: 3 pending … 5 processing, 7 canceled, 8 aborted, 9 completed. */
  state: number;
  reasons: string[];
  sheets: number | null;
}

export interface JobOptions {
  jobName?: string;
  copies?: number;
  colorMode?: string;
  sides?: string;
  media?: string;
}

// ------------------------------------------------------------------- api

export const api = {
  discover: () => invoke<Discovered[]>("discover_printers"),
  probe: (d: Device) => invoke<DeviceProfile>("probe_device", { host: d.host, hints: d.hints }),
  overview: (d: Device, ledm: boolean) =>
    invoke<Overview>("device_overview", { host: d.host, hints: d.hints, ledm }),

  emailAccounts: (host: string) => invoke<EmailAccount[]>("email_accounts", { host }),
  saveEmailAccount: (host: string, account: EmailAccount) =>
    invoke<string | null>("email_account_save", { host, account }),
  deleteEmailAccount: (host: string, id: string) => invoke<void>("email_account_delete", { host, id }),
  testEmailAccount: (host: string, id: string) => invoke<string>("email_account_test", { host, id }),
  scanToEmail: (host: string) => invoke<ScanToEmailConfig>("scan_to_email_get", { host }),
  setScanToEmail: (host: string, settings: ScanToEmailSettings) =>
    invoke<void>("scan_to_email_set", { host, settings }),

  scannerInfo: (d: Device) =>
    invoke<[ScannerCaps, ScannerStatus]>("scanner_info", { host: d.host, hints: d.hints }),
  scannerStatus: (d: Device) => invoke<ScannerStatus>("scanner_status", { host: d.host, hints: d.hints }),
  scan: (d: Device, request: ScanRequest, mode: BatchMode, reverseBacks: boolean, skipBlank: boolean) =>
    invoke<SessionView>("session_scan", {
      host: d.host,
      hints: d.hints,
      request,
      mode,
      reverseBacks,
      skipBlank,
    }),
  cancelScan: () => invoke<void>("scan_cancel"),
  /** Progress of the scan running in the backend, or null. */
  scanStatus: () => invoke<ScanProgress | null>("scan_status"),
  session: () => invoke<SessionView>("session_get"),
  finishFronts: (skipBlank: boolean) => invoke<SessionView>("session_finish_fronts", { skipBlank }),
  rotatePage: (id: number) => invoke<SessionView>("session_rotate", { id }),
  deletePage: (id: number) => invoke<SessionView>("session_delete", { id }),
  deleteBlank: () => invoke<SessionView>("session_delete_blank"),
  movePage: (id: number, to: number) => invoke<SessionView>("session_move", { id, to }),
  clearSession: () => invoke<SessionView>("session_clear"),
  saveSession: (format: "pdf" | "jpeg", path: string) =>
    invoke<string[]>("session_save", { format, path }),
  /** Add a page from a file: JPEG or PNG bytes. */
  importPage: (image: Uint8Array, dpi: number) =>
    invoke<SessionView>("session_import", image, { headers: { "x-dpi": String(dpi) } }),
  /** Full-size JPEG of a scanned page. */
  sessionPage: async (id: number) => new Uint8Array(await invoke<ArrayBuffer>("session_page", { id })),
  sessionPdf: async () => new Uint8Array(await invoke<ArrayBuffer>("session_pdf")),

  printCaps: (d: Device) => invoke<PrintCaps>("print_caps", { host: d.host, hints: d.hints }),
  printJobStatus: (d: Device, resource: string, jobId: number) =>
    invoke<JobStatus>("print_job_status", { host: d.host, resource, jobId }),
  print: (d: Device, resource: string, pdf: Uint8Array, options: JobOptions) =>
    invoke<number | null>("print_document", pdf, {
      headers: { "x-host": d.host, "x-resource": resource, "x-options": JSON.stringify(options) },
    }),
};
