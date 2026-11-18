import { createSwitcher } from "../src/switcher.ts";
import type { Switcher, SwitcherOptions } from "../src/switcher.ts";
import type { AccountInfo, Usage, UsageWindow } from "../src/types.ts";
import type { UsageResult } from "../src/usage.ts";

export const T0 = Date.parse("2026-11-18T12:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function win(percent: number, resetsAt: number | string | null = null): UsageWindow {
  const reset = typeof resetsAt === "string" ? Date.parse(resetsAt) : resetsAt;
  return { percent, limited: percent >= 100, resetsAt: reset };
}

export function usage(input: {
  rolling?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
}): Usage {
  return {
    rolling: input.rolling ?? win(0),
    weekly: input.weekly ?? win(0),
    monthly: input.monthly ?? win(0),
  };
}

export function jsonRequest(header: "x-api-key" | "authorization" | "both" = "authorization"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header === "authorization" || header === "both") headers["authorization"] = "Bearer opencode-managed";
  if (header === "x-api-key" || header === "both") headers["x-api-key"] = "opencode-managed";
  return new Request("https://opencode.ai/zen/go/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  });
}

export function keyOf(headers: Headers): string | null {
  const direct = headers.get("x-api-key");
  if (direct !== null) return direct;
  const authorization = headers.get("authorization");
  if (authorization === null) return null;
  return authorization.replace(/^Bearer\s+/i, "");
}

export interface FakeAccount {
  readonly id: string;
  readonly label: string;
  readonly key: string;
  readonly disabled?: boolean;
}

export interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly body: string;
  readonly redirect: RequestRedirect;
}

export interface Notification {
  readonly label: string;
  readonly reason: string;
}

export interface HarnessOptions {
  readonly accounts: readonly FakeAccount[];
  readonly usage?: Readonly<Record<string, UsageResult>>;
  readonly stored?: string;
  readonly options?: Partial<SwitcherOptions>;
  readonly activateFails?: boolean;
  readonly usageThrows?: boolean;
  /** Accounts whose usage read never settles while the switcher runs. */
  readonly usageStalls?: readonly string[];
  /** Per-account delay before a usage read answers, in milliseconds. */
  readonly usageDelayMs?: Readonly<Record<string, number>>;
  readonly unresolvable?: readonly string[];
  readonly respond?: (request: Request, index: number) => Response | Promise<Response>;
}

export interface Harness {
  readonly switcher: Switcher;
  readonly sent: SentRequest[];
  readonly activated: string[];
  readonly notifications: Notification[];
  readonly saved: string[];
  /** Activations the fake host performs on its own, as a person would in a UI. */
  readonly hostActivated: string[];
  stored(): string | undefined;
  setUsage(accountID: string, result: UsageResult): void;
  setNow(value: number): void;
  now(): number;
  addAccount(account: FakeAccount): void;
  manualActivate(accountID: string): void;
  accountInfos(): AccountInfo[];
}

export function createHarness(input: HarnessOptions): Harness {
  const accounts = input.accounts.map((account) => ({ ...account }));
  const keys = new Map(accounts.map((account) => [account.id, account.key] as const));
  const usageResults = new Map<string, UsageResult>(Object.entries(input.usage ?? {}));
  const sent: SentRequest[] = [];
  const activated: string[] = [];
  const hostActivated: string[] = [];
  const notifications: Notification[] = [];
  const saved: string[] = [];
  let stored: string | undefined = input.stored;
  let now = T0;

  const byKey = (key: string): FakeAccount | undefined =>
    accounts.find((account) => account.key === key);

  const switcher = createSwitcher({
    now: () => now,
    options: {
      pollIntervalMs: 60_000,
      fallbackCooldownMs: 15 * MINUTE,
      usageTimeoutMs: 100,
      version: "1.0.0",
      ...input.options,
    },
    loadAccounts: async () =>
      accounts.map((account) => ({
        id: account.id,
        label: account.label,
        disabled: account.disabled === true,
      })),
    resolveKey: async (accountID) => {
      if (input.unresolvable?.includes(accountID) === true) return undefined;
      const key = keys.get(accountID);
      return key === undefined ? undefined : { key };
    },
    readUsage: async (credential) => {
      if (input.usageThrows === true) throw new Error("usage endpoint exploded");
      const account = byKey(credential.key);
      if (account === undefined) return { type: "unavailable" };
      if (input.usageStalls?.includes(account.id) === true) {
        return await new Promise<UsageResult>(() => undefined);
      }
      const delay = input.usageDelayMs?.[account.id] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return usageResults.get(account.id) ?? { type: "unavailable" };
    },
    activate: async (accountID) => {
      if (input.activateFails === true) throw new Error("activation refused");
      activated.push(accountID);
    },
    loadCurrent: async () => stored,
    saveCurrent: async (accountID) => {
      stored = accountID;
      saved.push(accountID);
    },
    notify: async (event) => {
      notifications.push({ label: event.label, reason: event.reason });
    },
    fetch: async (request) => {
      const index = sent.length;
      const copy = request.clone();
      sent.push({
        url: request.url,
        method: request.method,
        key: keyOf(request.headers),
        body: await copy.text(),
        redirect: request.redirect,
      });
      return (await input.respond?.(request, index)) ?? new Response("ok", { status: 200 });
    },
  });

  return {
    switcher,
    sent,
    activated,
    notifications,
    saved,
    hostActivated,
    stored: () => stored,
    setUsage: (accountID, result) => usageResults.set(accountID, result),
    setNow: (value) => {
      now = value;
    },
    now: () => now,
    addAccount: (account) => {
      accounts.push({ ...account });
      keys.set(account.id, account.key);
    },
    manualActivate: (accountID) => {
      hostActivated.push(accountID);
    },
    accountInfos: () =>
      accounts.map((account) => ({
        id: account.id,
        label: account.label,
        disabled: account.disabled === true,
      })),
  };
}
