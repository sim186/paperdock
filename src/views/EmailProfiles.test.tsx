// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import EmailProfiles from "./EmailProfiles";
import { api } from "../api";
import { I18nProvider } from "../i18n";
import { SnackbarProvider } from "../snackbar";
import { cleanAppPassword, defaultDisplayName, providerForEmail } from "./emailProviders";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

function show() {
  vi.spyOn(api, "emailAccounts").mockResolvedValue([]);
  return render(
    <I18nProvider><SnackbarProvider>
      <EmailProfiles host="printer.local" />
    </SnackbarProvider></I18nProvider>,
  );
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("guided email setup", () => {
  it("creates a Gmail profile from just the address and app password, then tests it", async () => {
    const save = vi.spyOn(api, "saveEmailAccount").mockResolvedValue("7");
    const test = vi.spyOn(api, "testEmailAccount").mockResolvedValue("Success");
    show();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Create the first profile/i }));
    await user.click(screen.getByRole("button", { name: /Gmail/ }));
    expect(screen.getByText(/app passwords page/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Your Gmail address/i), "studio@gmail.com");
    await user.type(screen.getByLabelText(/^App password/i), "abcd efgh ijkl mnop");
    expect(screen.getByLabelText(/Name on the printer panel/i)).toHaveValue("studio@gmail.com");
    await user.click(screen.getByRole("button", { name: /^Connect$/ }));

    await waitFor(() => expect(test).toHaveBeenCalledWith("printer.local", "7"));
    expect(save).toHaveBeenCalledWith("printer.local", expect.objectContaining({
      id: null,
      emailAddress: "studio@gmail.com",
      smtpServer: "smtp.gmail.com",
      port: 465,
      useSsl: true,
      username: "studio@gmail.com",
      password: "abcdefghijklmnop",
    }));
  });

  it("suggests the right provider when the address belongs to another one", async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Create the first profile/i }));
    await user.click(screen.getByRole("button", { name: /Gmail/ }));
    await user.type(screen.getByLabelText(/Your Gmail address/i), "me@icloud.com");
    await user.click(screen.getByRole("button", { name: /Use iCloud Mail/ }));
    expect(screen.getByRole("heading", { name: /Connect iCloud Mail/ })).toBeInTheDocument();
  });

  it("opens the full form for other providers", async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Create the first profile/i }));
    await user.click(screen.getByRole("button", { name: /Other provider/ }));
    expect(screen.getByRole("textbox", { name: /^Server$/ })).toHaveValue("");
  });
});

describe("provider helpers", () => {
  it("detects providers from the address domain", () => {
    expect(providerForEmail("A@GMAIL.com")?.id).toBe("gmail");
    expect(providerForEmail("x@hotmail.it")?.id).toBe("outlook");
    expect(providerForEmail("x@example.com")).toBeUndefined();
  });

  it("keeps display names within the panel limit", () => {
    expect(defaultDisplayName("short@gmail.com")).toBe("short@gmail.com");
    expect(defaultDisplayName("a.very.long.name.indeed@gmail.com")).toBe("a.very.long.name.indeed");
  });

  it("strips spaces from app passwords", () => {
    expect(cleanAppPassword(" abcd efgh\tijkl mnop ")).toBe("abcdefghijklmnop");
  });
});
