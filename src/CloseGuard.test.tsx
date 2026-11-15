// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { api } from "./api";
import { I18nProvider } from "./i18n";
import CloseGuard from "./CloseGuard";

const mocks = vi.hoisted(() => ({
  onClose: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onClose, destroy: mocks.destroy }),
}));

let closeHandler: (event: { preventDefault: () => void }) => Promise<void>;
async function requestClose() {
  const preventDefault = vi.fn();
  await act(async () => { await closeHandler({ preventDefault }); });
  expect(preventDefault).toHaveBeenCalled();
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lang", "en");
  mocks.onClose.mockImplementation(async (handler) => { closeHandler = handler; return () => {}; });
  mocks.destroy.mockResolvedValue(undefined);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function showGuard() {
  render(<I18nProvider><CloseGuard /></I18nProvider>);
}

describe("closing the application", () => {
  it("closes without prompting if there is no unsaved work or active scan", async () => {
    vi.spyOn(api, "closeStatus").mockResolvedValue({ unsavedPages: false, scanning: false });
    showGuard();
    await requestClose();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(screen.queryByText("Close PaperDock?")).not.toBeInTheDocument();
  });

  it("lets the user keep an unsaved document open or close anyway", async () => {
    vi.spyOn(api, "closeStatus").mockResolvedValue({ unsavedPages: true, scanning: false });
    showGuard();
    await requestClose();
    expect(screen.getByText(/current document has unsaved pages/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(mocks.destroy).not.toHaveBeenCalled();
    await requestClose();
    await userEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("warns when a scan is running even without saved pages", async () => {
    vi.spyOn(api, "closeStatus").mockResolvedValue({ unsavedPages: false, scanning: true });
    showGuard();
    await requestClose();
    expect(screen.getByText(/A scan is in progress/)).toBeInTheDocument();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });

  it("warns rather than closing when the status cannot be checked", async () => {
    vi.spyOn(api, "closeStatus").mockRejectedValue(new Error("unavailable"));
    showGuard();
    await requestClose();
    await waitFor(() => expect(screen.getByText(/could not check/)).toBeInTheDocument());
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
});
