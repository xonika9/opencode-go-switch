import { blockOf, causeOf, exhaustedWindow, isEligible, pickNext } from "./select.ts";
import { formatStatus } from "./status.ts";
import { createAccount } from "./types.ts";
import type { Account, AccountInfo } from "./types.ts";
import type { UsageCredential, UsageResult } from "./usage.ts";
import { retryAfterMs } from "./usage.ts";

export interface SwitcherOptions {
  readonly pollIntervalMs: number;
  readonly fallbackCooldownMs: number;
  readonly toast: boolean;
}

export interface SwitcherDeps {
  readonly now: () => number;
  readonly loadAccounts: () => Promise<readonly AccountInfo[]>;
  readonly resolveKey: (accountID: string) => Promise<UsageCredential | undefined>;
  readonly readUsage: (credential: UsageCredential) => Promise<UsageResult>;
  readonly activate: (accountID: string) => Promise<void>;
  readonly loadCurrent: () => Promise<string | undefined>;
  readonly saveCurrent: (accountID: string) => Promise<void>;
  readonly notify: (event: { readonly label: string; readonly reason: string }) => void | Promise<void>;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly options: SwitcherOptions;
}

/** The part of an OpenCode session HTTP hook this plugin cares about. */
export interface HttpRequestInput {
  readonly model: { readonly providerID: string };
  request: Request;
}

export interface HttpResponseInput extends HttpRequestInput {
  response: Response;
}

interface RequestState {
  accountID: string;
  tried: Set<string>;
  /** Unread copy of the body, taken before OpenCode sends the request. */
  template: Request | undefined;
}

const STICKY = "sticky: still has headroom";

function withKey(request: Request, key: string): Request {
  const headers = new Headers(request.headers);
  if (headers.has("x-api-key")) headers.set("x-api-key", key);
  else headers.set("authorization", `Bearer ${key}`);
  return new Request(request, { headers });
}

function cloneRequest(request: Request): Request | undefined {
  try {
    return request.clone();
  } catch {
    return undefined;
  }
}

/**
 * Owns the account list, the current account, usage knowledge, and the two request hooks.
 * All I/O arrives through `deps`, so tests drive it without a real OpenCode or network.
 */
export function createSwitcher(deps: SwitcherDeps) {
  let accounts: Account[] = [];
  let current: string | null = null;
  let reason = "not chosen yet";
  let ready: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling: Promise<void> | null = null;
  const requests = new WeakMap<Request, RequestState>();

  const find = (id: string | null): Account | undefined =>
    id === null ? undefined : accounts.find((account) => account.id === id);

  function currentAccount(): Account | undefined {
    return find(current);
  }

  async function syncAccounts(): Promise<void> {
    const infos = await deps.loadAccounts();
    const previous = new Map(accounts.map((account) => [account.id, account] as const));
    accounts = infos.map((info) => {
      const before = previous.get(info.id);
      if (before === undefined) return createAccount(info);
      before.label = info.label;
      before.disabled = info.disabled;
      return before;
    });
  }

  async function pollOnce(): Promise<void> {
    try {
      await syncAccounts();
    } catch {
      return;
    }
    const now = deps.now();
    const snapshot = [...accounts];
    await Promise.all(
      snapshot.map(async (account) => {
        let credential: UsageCredential | undefined;
        try {
          credential = await deps.resolveKey(account.id);
        } catch {
          return;
        }
        if (credential === undefined || credential.key === "") {
          account.invalidKey = true;
          account.checkedAt = now;
          return;
        }
        let result: UsageResult;
        try {
          result = await deps.readUsage(credential);
        } catch {
          result = { type: "unavailable" };
        }
        account.checkedAt = now;
        if (result.type === "usage") {
          account.usage = result.usage;
          account.invalidKey = false;
          account.blockedUntil = null;
          account.blockedLabel = null;
        } else if (result.type === "invalid-key") {
          account.invalidKey = true;
        }
      }),
    );
  }

  function refresh(): Promise<void> {
    polling ??= pollOnce().finally(() => {
      polling = null;
    });
    return polling;
  }

  async function boot(): Promise<void> {
    try {
      await syncAccounts();
    } catch {
      return;
    }
    try {
      const stored = await deps.loadCurrent();
      if (stored !== undefined && accounts.some((account) => account.id === stored)) {
        current = stored;
        reason = "restored from storage";
      }
    } catch {
      return;
    }
  }

  async function switchTo(account: Account, why: string, cause: string): Promise<void> {
    current = account.id;
    reason = why;
    try {
      await deps.saveCurrent(account.id);
    } catch {
      // Selection still holds in memory for this process.
    }
    try {
      await deps.activate(account.id);
    } catch {
      // The request must go through even when activation fails.
    }
    if (deps.options.toast) {
      try {
        await deps.notify({ label: account.label, reason: cause });
      } catch {
        // Notifications are best effort.
      }
    }
  }

  function markInvalid(id: string | null): void {
    const account = find(id);
    if (account !== undefined) account.invalidKey = true;
  }

  /**
   * Applies a 429/402 to one account. Returns false when refreshed usage says the account still has
   * headroom (so the limit was not ours and the response should stand).
   */
  async function noteLimit(id: string | null, response: Response): Promise<boolean> {
    const account = find(id);
    if (account === undefined) return true;
    let credential: UsageCredential | undefined;
    try {
      credential = await deps.resolveKey(account.id);
    } catch {
      credential = undefined;
    }
    if (credential === undefined || credential.key === "") {
      account.invalidKey = true;
      return true;
    }
    const now = deps.now();
    let result: UsageResult;
    try {
      result = await deps.readUsage(credential);
    } catch {
      result = { type: "unavailable" };
    }
    if (result.type === "usage") {
      account.usage = result.usage;
      account.checkedAt = now;
      account.invalidKey = false;
      account.blockedUntil = null;
      account.blockedLabel = null;
      if (exhaustedWindow(result.usage, now) === null) return false;
      void refresh();
      return true;
    }
    if (result.type === "invalid-key") {
      account.invalidKey = true;
      return true;
    }
    const wait = retryAfterMs(response.headers.get("retry-after"), now);
    account.blockedUntil = now + (wait ?? deps.options.fallbackCooldownMs);
    account.blockedLabel = "limit";
    void refresh();
    return true;
  }

  const api = {
    /** Loads accounts and the persisted current account. Safe to call repeatedly. */
    init(): Promise<void> {
      ready ??= boot();
      return ready;
    },

    /** Loads state, then polls usage in the background and keeps polling. */
    async start(): Promise<void> {
      await api.init();
      if (timer === null && deps.options.pollIntervalMs > 0) {
        timer = setInterval(() => {
          void refresh();
        }, deps.options.pollIntervalMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
      void refresh();
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    /** Polls every account now, coalescing with a poll already in flight. */
    refresh(): Promise<void> {
      return refresh();
    },

    snapshot(): { accounts: readonly Account[]; currentID: string | null; reason: string } {
      return { accounts: [...accounts], currentID: current, reason };
    },

    /** Text for the `go_accounts` tool; with `label`, makes that account current first. */
    async status(label?: string): Promise<string> {
      await api.init();
      const now = deps.now();
      const stale = accounts.some(
        (account) => account.checkedAt === 0 || now - account.checkedAt >= deps.options.pollIntervalMs,
      );
      if (stale) await refresh();
      try {
        await syncAccounts();
      } catch {
        // Keep the list we have.
      }

      const wanted = label?.trim();
      if (wanted !== undefined && wanted !== "") {
        const target =
          accounts.find((account) => account.label === wanted) ??
          accounts.find((account) => account.label.toLowerCase() === wanted.toLowerCase());
        if (target === undefined) {
          const labels = accounts.map((account) => account.label).join(", ");
          throw new Error(
            `Unknown account "${wanted}". Connected accounts: ${labels === "" ? "none" : labels}.`,
          );
        }
        if (target.id !== current) await switchTo(target, "explicitly selected", "explicitly selected");
      }

      return formatStatus({ accounts, currentID: current, reason, now: deps.now() });
    },

    /** Puts the current account's key on the request, switching first when it is known to be blocked. */
    async onRequest(input: HttpRequestInput): Promise<void> {
      try {
        await api.init();
        const now = deps.now();
        let account = currentAccount();

        if (account === undefined || !isEligible(account, now)) {
          const next = pickNext(accounts, now);
          if (next === undefined) return;
          if (next.id !== account?.id) {
            const cause = account === undefined ? "startup" : causeOf(account, blockOf(account, now));
            const why = account === undefined ? "startup: earliest monthly reset" : `switched: ${cause}`;
            await switchTo(next, why, cause);
          }
          account = next;
        } else {
          reason = STICKY;
        }

        const credential = await deps.resolveKey(account.id).catch(() => undefined);
        if (credential === undefined || credential.key === "") {
          account.invalidKey = true;
          return;
        }
        const replaced = withKey(input.request, credential.key);
        requests.set(replaced, {
          accountID: account.id,
          tried: new Set([account.id]),
          template: cloneRequest(replaced),
        });
        input.request = replaced;
      } catch {
        // A hook must never fail the request.
      }
    },

    /**
     * Retries a limit or auth failure with the next account inside the same hook call. Returns the
     * first response untouched when every account has been tried.
     */
    async onResponse(input: HttpResponseInput): Promise<void> {
      const first = input.response;
      try {
        await api.init();
        const state = requests.get(input.request);
        const base = state?.template ?? input.request;
        const tried = new Set(state?.tried ?? []);
        let accountID = state?.accountID ?? current;
        let response = first;

        for (let step = 0; step <= accounts.length; step++) {
          if (response.status === 401 || response.status === 403) {
            markInvalid(accountID);
          } else if (response.status === 429 || response.status === 402) {
            if (!(await noteLimit(accountID, response))) return;
          } else {
            if (response !== first) input.response = response;
            return;
          }

          const now = deps.now();
          const active = currentAccount();
          let target: Account | undefined;
          if (active !== undefined && active.id !== accountID) {
            target = active;
          } else {
            target = pickNext(accounts, now, tried);
            if (target === undefined) return;
            const failed = find(accountID);
            const cause = failed === undefined ? "limit" : causeOf(failed, blockOf(failed, now));
            await switchTo(target, `switched: ${cause}`, cause);
          }
          if (tried.has(target.id)) return;
          tried.add(target.id);

          const credential = await deps.resolveKey(target.id).catch(() => undefined);
          if (credential === undefined || credential.key === "") {
            markInvalid(target.id);
            return;
          }
          const template = cloneRequest(base);
          if (template === undefined) return;
          response = await deps.fetch(withKey(template, credential.key));
          accountID = target.id;
        }
      } catch {
        // Leave the original response in place.
      }
    },
  };

  return api;
}

export type Switcher = ReturnType<typeof createSwitcher>;
