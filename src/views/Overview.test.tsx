// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import OverviewView, { SLOW_AFTER_MS } from "./Overview";
import { api, type Overview } from "../api";
import { I18nProvider } from "../i18n";
import { SnackbarProvider } from "../snackbar";

const device = { host: "printer.local", hints: {} } as never;
const profile = { model: "Test printer", features: { ipp: true, ledm: false } } as never;
const overview = {
  model: "Test printer",
  state: "idle",
  stateMessage: null,
  alerts: [],
  supplies: [{ name: "Black", code: "K", level: 62, state: "ok" }],
} as unknown as Overview;

function show(onPickDevice = vi.fn()) {
  render(
    <I18nProvider><SnackbarProvider>
      <OverviewView device={device} profile={profile} onPickDevice={onPickDevice} />
    </SnackbarProvider></I18nProvider>,
  );
  return onPickDevice;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  localStorage.clear();
  localStorage.setItem("lang", "en");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("overview while the printer is slow to answer", () => {
  it("shows a skeleton when nothing is known yet", () => {
    vi.spyOn(api, "overview").mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByText("Contacting the printer…")).toBeInTheDocument();
  });

  it("shows the last known state while updating, and saves fresh data for next time", async () => {
    localStorage.setItem("overview:printer.local", JSON.stringify({ savedAt: Date.now() - 5 * 60000, data: overview }));
    vi.spyOn(api, "overview").mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByText("62")).toBeInTheDocument();
    expect(screen.getByText(/Last known state \(5 minutes ago\)/)).toBeInTheDocument();
    cleanup();

    localStorage.clear();
    localStorage.setItem("lang", "en");
    vi.spyOn(api, "overview").mockResolvedValue(overview);
    show();
    expect(await screen.findByText("62")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("overview:printer.local")!).data.model).toBe("Test printer");
  });

  it("says what to check after a few seconds without an answer", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "overview").mockReturnValue(new Promise(() => {}));
    const pick = show();
    expect(screen.queryByText(/hasn't answered yet/)).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(SLOW_AFTER_MS);
    });
    expect(screen.getByText(/hasn't answered yet/)).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: /Choose another device/ }).click());
    expect(pick).toHaveBeenCalled();
  });
});
