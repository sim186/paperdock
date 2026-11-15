// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import ScanView from "./Scan";
import { api, type SessionView } from "../api";
import { I18nProvider } from "../i18n";
import { SnackbarProvider } from "../snackbar";
import { ActivityProvider } from "../activity";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const caps = {
  makeAndModel: "Test scanner", namespace: "test", version: "1",
  colorModes: ["RGB24"], platen: null,
  adf: { maxWidth: 2550, maxHeight: 3508, resolutions: [300] },
  adfDuplex: false, adfCapacity: 20,
};
const status = { state: "Idle", adfState: "ScannerAdfLoaded" };
const pages = [1, 2].map((id) => ({ id, rotation: 0, thumb: "data:image/jpeg;base64,", blank: false }));
const failure = { code: "scanner_error", message: "Scanner failed", params: {} };

function showScan(session: SessionView = { pages: [], awaitingBacks: null }) {
  vi.spyOn(api, "scannerInfo").mockResolvedValue([caps, status]);
  vi.spyOn(api, "scannerStatus").mockResolvedValue(status);
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "scanStatus").mockResolvedValue(null);
  return render(
    <I18nProvider><SnackbarProvider><ActivityProvider>
      <ScanView device={{ host: "scanner.local", hints: {} }} active />
    </ActivityProvider></SnackbarProvider></I18nProvider>,
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  localStorage.clear();
  localStorage.setItem("lang", "en");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("scanning documents", () => {
  it("keeps blank-page removal off for new preferences and explains its risk", async () => {
    showScan();
    const toggle = await screen.findByRole("switch", { name: /Remove blank pages/i });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/mistake lightly marked pages/)).toBeInTheDocument();
  });

  it("preserves an existing choice to remove blank pages", async () => {
    localStorage.setItem("scanPrefs", JSON.stringify({ skipBlank: true }));
    showScan();
    expect(await screen.findByRole("switch", { name: /Remove blank pages/i })).toBeChecked();
  });

  it("explains that the interrupted batch was not added when there are no earlier pages", async () => {
    vi.spyOn(api, "scan").mockRejectedValue(failure);
    showScan();
    await userEvent.click(await screen.findByRole("button", { name: /^Scan$/ }));
    expect(await screen.findByText(/interrupted batch was not added/)).toHaveTextContent("There are no pages in the document yet.");
  });

  it("shows the recovery guidance when the user cancels a scan", async () => {
    vi.spyOn(api, "scan").mockRejectedValue({ code: "cancelled", message: "Cancelled", params: {} });
    showScan();
    await userEvent.click(await screen.findByRole("button", { name: /^Scan$/ }));
    expect(await screen.findByText(/interrupted batch was not added/)).toHaveTextContent("There are no pages in the document yet.");
  });

  it("reports earlier pages after a scan fails and clears the notice on retry", async () => {
    const scan = vi.spyOn(api, "scan").mockRejectedValueOnce(failure).mockResolvedValueOnce({ pages, awaitingBacks: null });
    showScan({ pages, awaitingBacks: null });
    await screen.findByText("2 pages");
    await userEvent.click(screen.getByRole("button", { name: "Scan more sheets" }));
    expect(await screen.findByText(/interrupted batch was not added/)).toHaveTextContent("The document still contains 2 pages.");
    await userEvent.click(screen.getByRole("button", { name: "Scan more sheets" }));
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/interrupted batch was not added/)).not.toBeInTheDocument();
  });

  it("opens the guide from the information icon before scanning", async () => {
    showScan();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /Sides/ }), "manual");
    await userEvent.click(screen.getByRole("button", { name: "Show guide" }));
    const guide = screen.getByRole("dialog", { name: "Time to turn the page." });
    expect(within(guide).getByText(/Scan the fronts first/)).toBeInTheDocument();
    expect(within(guide).getByText("Pick up the stack")).toBeInTheDocument();
    await userEvent.click(within(guide).getByRole("button", { name: "Next step" }));
    expect(within(guide).getByText("Turn and reload")).toBeInTheDocument();
    await userEvent.click(within(guide).getByRole("button", { name: "Next step" }));
    expect(within(guide).getByText("Scan and check")).toBeInTheDocument();
    expect(within(guide).queryByRole("button", { name: "Scan backs" })).not.toBeInTheDocument();
  });

  it("allows closing and reopening the manual duplex guide", async () => {
    showScan({ pages, awaitingBacks: 2 });
    const guide = await screen.findByRole("dialog", { name: "Time to turn the page." });
    await userEvent.click(within(guide).getByRole("button", { name: "Close guide" }));
    expect(screen.queryByRole("dialog", { name: "Time to turn the page." })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show guide" }));
    expect(screen.getByRole("dialog", { name: "Time to turn the page." })).toBeInTheDocument();
  });

  it("explains how to proceed when scanning the backs fails", async () => {
    vi.spyOn(api, "scan").mockRejectedValue(failure);
    showScan({ pages, awaitingBacks: 2 });
    const guide = await screen.findByRole("dialog", { name: "Time to turn the page." });
    expect(within(guide).getByText("Pick up the stack")).toBeInTheDocument();
    expect(within(guide).getByText(/illustration is decorative/)).toBeInTheDocument();
    await userEvent.click(within(guide).getByRole("button", { name: "Next step" }));
    await userEvent.click(within(guide).getByRole("button", { name: "Next step" }));
    await userEvent.click(within(guide).getByRole("button", { name: "Scan backs" }));
    expect(await screen.findByText(/interrupted batch was not added/)).toHaveTextContent("Scan the backs or choose to continue with fronts only before saving.");
  });
});
