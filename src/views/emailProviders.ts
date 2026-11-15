/** Known email providers for the guided profile setup. */
export type ProviderId = "gmail" | "outlook" | "icloud" | "yahoo" | "libero" | "aruba";

export interface EmailProvider {
  id: ProviderId;
  label: string;
  server: string;
  port: number;
  ssl: boolean;
  /** Needs an app-specific password instead of the normal account password. */
  appPassword: boolean;
  /** Page where the user creates the app password or checks account security. */
  helpUrl?: string;
  /** Domains that identify the provider from an email address. */
  domains: string[];
  /** Password login over SMTP is being phased out by the provider. */
  warning?: boolean;
}

export const PROVIDERS: EmailProvider[] = [
  {
    id: "gmail",
    label: "Gmail",
    server: "smtp.gmail.com",
    port: 465,
    ssl: true,
    appPassword: true,
    helpUrl: "https://myaccount.google.com/apppasswords",
    domains: ["gmail.com", "googlemail.com"],
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    server: "smtp.office365.com",
    port: 587,
    ssl: true,
    appPassword: true,
    helpUrl: "https://account.microsoft.com/security",
    domains: ["outlook.com", "outlook.it", "hotmail.com", "hotmail.it", "live.com", "live.it", "msn.com"],
    warning: true,
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    server: "smtp.mail.me.com",
    port: 587,
    ssl: true,
    appPassword: true,
    helpUrl: "https://account.apple.com/account/manage",
    domains: ["icloud.com", "me.com", "mac.com"],
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    server: "smtp.mail.yahoo.com",
    port: 465,
    ssl: true,
    appPassword: true,
    helpUrl: "https://login.yahoo.com/account/security",
    domains: ["yahoo.com", "yahoo.it", "ymail.com"],
  },
  {
    id: "libero",
    label: "Libero",
    server: "smtp.libero.it",
    port: 465,
    ssl: true,
    appPassword: false,
    domains: ["libero.it", "inwind.it", "blu.it", "iol.it"],
  },
  {
    id: "aruba",
    label: "Aruba",
    server: "smtps.aruba.it",
    port: 465,
    ssl: true,
    appPassword: false,
    domains: [],
  },
];

export function providerForEmail(email: string): EmailProvider | undefined {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return undefined;
  return PROVIDERS.find((p) => p.domains.includes(domain));
}

export function providerForServer(server: string, port: number): EmailProvider | undefined {
  return PROVIDERS.find((p) => p.server === server.trim() && p.port === port);
}

/** Display name shown on the printer panel: the address if it fits, else its local part. */
export function defaultDisplayName(email: string, max = 25): string {
  const e = email.trim();
  if (e.length <= max) return e;
  return e.split("@")[0].slice(0, max);
}

/** App passwords are often shown in groups ("abcd efgh ijkl mnop"); SMTP wants them joined. */
export function cleanAppPassword(pw: string): string {
  return pw.replace(/\s+/g, "");
}
