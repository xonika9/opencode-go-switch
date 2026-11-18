import { causeOf, classify, exhaustedWindow, hasKnownHeadroom, pickNext, usableAsCurrent } from "./select.ts";
import type { Block } from "./select.ts";
import { formatMoment, formatStatus, formatWhen } from "./status.ts";
import type { LastSwitch } from "./status.ts";
import { createAccount } from "./types.ts";
import type { Account, AccountInfo } from "./types.ts";
import type { UsageCredential, UsageResult } from "./usage.ts";
import { retryAfterMs } from "./usage.ts";

export interface SwitcherOptions {
  readonly pollIntervalMs: number;
  readonly fallbackCooldownMs: number;
  /** How long the first request waits for the startup usage poll. */
  readonly usageTimeoutMs: number;
  readonly version: string;
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

/** What OpenCode may decide after a failed attempt. */
export type RetryDecision = { readonly retry: false } | { readonly retry: true; readonly delay: number };

/** The part of OpenCode's provider retry hook this plugin reads and edits. */
export interface RetryInput {
  readonly error: { readonly status?: number; readonly retryAfterMs?: number };
  readonly attempt: number;
  decision: RetryDecision;
}

interface RequestState {
  accountID: string;
  tried: Set<string>;
  /** Unread copy of the body, taken before OpenCode sends the request. */
  template: Request | undefined;
}

/** A usage read triggered by a limit must not hang the request. */
const LIMIT_USAGE_BUDGET_MS = 2_000;

const STICKY = "sticky: still has headroom";
const STICKY_UNKNOWN = "sticky: usage unknown";
const STARTUP = "startup: earliest monthly reset";
const EXPLICIT = "explicitly selected";
const RESTORED = "restored from storage";

/**
 * Puts the key on the request in whichever header the caller already uses, so the provider keeps
 * accepting it. A request with neither header gets an authorization header.
 */
function withKey(request: Request, key: string, redirect?: RequestRedirect): Request {
  const headers = new Headers(request.headers);
  const usesApiKey = headers.has("x-api-key");
  const usesAuthorization = headers.has("authorization");
  if (usesApiKey) headers.set("x-api-key", key);
  if (usesAuthorization) headers.set("authorization", `Bearer ${key}`);
  if (!usesApiKey && !usesAuthorization) headers.set("authorization", `Bearer ${key}`);
  const init: RequestInit = redirect === undefined ? { headers } : { headers, redirect };
  return new Request(request, init);
}

function cloneRequest(request: Request): Request | undefined {
  try {
    return request.clone();
  } catch {
    return undefined;
  }
}

/**
 * Owns the account list, the current account, usage knowledge, and the request hooks.
 * All I/O arrives through `deps`, so tests drive it without a real OpenCode or network.
 */
export function createSwitcher(deps: SwitcherDeps) {
  let accounts: Account[] = [];
  let current: string | null = null;
  let reason = "not chosen yet";
  let lastSwitch: LastSwitch | null = null;
  let ready: Promise<void> | null = null;
  let startupPoll: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling: Promise<void> | null = null;
  let deciding: Promise<unknown> = Promise.resolve();
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
    startupPoll = refresh();
    try {
      const stored = await deps.loadCurrent();
      if (stored !== undefined && accounts.some((account) => account.id === stored)) {
        current = stored;
        reason = RESTORED;
      }
    } catch {
      // Without a stored id the first request picks by the rule.
    }
  }

  /** Waits for the startup poll, but never longer than the usage timeout. */
  function awaitStartupUsage(): Promise<void> {
    const pending = startupPoll ?? refresh();
    return new Promise((resolve) => {
      let settled = false;
      let limit: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (limit !== undefined) clearTimeout(limit);
        resolve();
      };
      limit = setTimeout(finish, Math.max(0, deps.options.usageTimeoutMs));
      pending.then(finish, finish);
    });
  }

  /** Runs a decision alone, so two failures cannot both switch and both announce it. */
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = deciding.then(work, work);
    deciding = run.catch(() => undefined);
    return run;
  }

  async function switchTo(account: Account, why: string, cause: string): Promise<void> {
    const previous = currentAccount()?.label ?? null;
    current = account.id;
    reason = why;
    lastSwitch = { from: previous, to: account.label, cause, at: deps.now() };
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
    try {
      await deps.notify({ label: account.label, reason: cause });
    } catch {
      // Notifications are best effort.
    }
  }

  function markInvalid(id: string | null): void {
    const account = find(id);
    if (account !== undefined) account.invalidKey = true;
  }

  /** Reads usage without letting a slow endpoint hold the request for longer than the budget. */
  async function readUsageBounded(credential: UsageCredential): Promise<UsageResult> {
    const read = deps.readUsage(credential).catch((): UsageResult => ({ type: "unavailable" }));
    let limit: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UsageResult>((resolve) => {
      limit = setTimeout(() => resolve({ type: "unavailable" }), LIMIT_USAGE_BUDGET_MS);
    });
    try {
      return await Promise.race([read, deadline]);
    } finally {
      if (limit !== undefined) clearTimeout(limit);
    }
  }

  /**
   * Applies a 429/402 to one account. Returns false when a fresh usage read says the account still
   * has headroom in every window (so the limit was not ours and the response should stand).
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
    const result = await readUsageBounded(credential);
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

  async function refreshIfStale(): Promise<void> {
    const now = deps.now();
    const stale = accounts.some(
      (account) => account.checkedAt === 0 || now - account.checkedAt >= deps.options.pollIntervalMs,
    );
    if (stale) await refresh();
  }

  function statusText(): string {
    return formatStatus({
      version: deps.options.version,
      accounts,
      currentID: current,
      reason,
      lastSwitch,
      now: deps.now(),
    });
  }

  /** Makes the named account current, or returns the refusal to print above the status. */
  async function selectByLabel(wanted: string): Promise<string | null> {
    const lower = wanted.toLowerCase();
    const matches = accounts.filter((account) => account.label.toLowerCase() === lower);
    if (matches.length === 0) {
      const labels = accounts.map((account) => account.label).join(", ");
      return `Refused: no connected account is labelled "${wanted}". Connected accounts: ${labels === "" ? "none" : labels}.`;
    }
    if (matches.length > 1) {
      const labels = matches.map((account) => account.label).join(", ");
      return `Refused: ${matches.length} connected accounts are labelled "${wanted}" (${labels}); rename one of them before selecting it.`;
    }
    const target = matches[0]!;
    const now = deps.now();
    const state = classify(target, now);
    if (state.kind !== "eligible" && state.kind !== "unknown") {
      return `Refused: "${target.label}" ${refusalReason(state, now)}.`;
    }
    if (target.id !== current) await switchTo(target, EXPLICIT, EXPLICIT);
    return null;
  }

  function refusalReason(state: Block, now: number): string {
    switch (state.kind) {
      case "disabled":
        return "is disabled";
      case "invalid-key":
        return "has an invalid key";
      case "exhausted":
        return `is exhausted: ${state.label} until ${formatWhen(state.until, now)}`;
      case "cooldown":
        return `is cooling down until ${formatMoment(state.until, now)}`;
    }
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
      await refreshIfStale();
      try {
        await syncAccounts();
      } catch {
        // Keep the list we have.
      }

      const wanted = label?.trim();
      const refusal = wanted === undefined || wanted === "" ? null : await selectByLabel(wanted);
      const text = statusText();
      return refusal === null ? text : `${refusal}\n\n${text}`;
    },

    /** Puts the current account's key on the request, switching first when it is known to be blocked. */
    async onRequest(input: HttpRequestInput): Promise<void> {
      try {
        await api.init();
        let account = currentAccount();

        if (account === undefined) {
          await awaitStartupUsage();
          const picked = pickNext(accounts, deps.now());
          if (picked === undefined) return;
          await switchTo(picked, STARTUP, STARTUP);
          account = picked;
        } else if (!usableAsCurrent(account, deps.now())) {
          const now = deps.now();
          const next = pickNext(accounts, now);
          if (next === undefined) return;
          const cause = causeOf(account, classify(account, now));
          await switchTo(next, `switched: ${cause}`, cause);
          account = next;
        } else {
          reason = hasKnownHeadroom(account, deps.now()) ? STICKY : STICKY_UNKNOWN;
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
     * Retries a limit or auth failure with the next account inside the same hook call. The first
     * response stands when no account is left to try.
     */
    async onResponse(input: HttpResponseInput): Promise<void> {
      const first = input.response;
      try {
        await api.init();
        const state = requests.get(input.request);
        const base = state?.template ?? cloneRequest(input.request);
        if (base === undefined) return;
        const tried = new Set<string>(state?.tried ?? []);
        let accountID = state?.accountID ?? current;
        let response = first;

        for (let step = 0; step <= accounts.length; step++) {
          if (response.status === 403) return;
          if (response.status === 401) {
            markInvalid(accountID);
          } else if (response.status === 429 || response.status === 402) {
            if (!(await noteLimit(accountID, response))) {
              if (response !== first) input.response = response;
              return;
            }
          } else {
            if (response !== first) input.response = response;
            return;
          }

          const target = await serialize(async () => {
            const now = deps.now();
            const active = currentAccount();
            if (
              active !== undefined &&
              active.id !== accountID &&
              !tried.has(active.id) &&
              usableAsCurrent(active, now)
            ) {
              return active;
            }
            const next = pickNext(accounts, now, tried);
            if (next === undefined) return undefined;
            const failed = find(accountID);
            const cause = failed === undefined ? "limit" : causeOf(failed, classify(failed, now));
            await switchTo(next, `switched: ${cause}`, cause);
            return next;
          });
          if (target === undefined) return;
          if (tried.has(target.id)) return;
          tried.add(target.id);

          const credential = await deps.resolveKey(target.id).catch(() => undefined);
          if (credential === undefined || credential.key === "") {
            markInvalid(target.id);
            return;
          }
          const template = cloneRequest(base);
          if (template === undefined) return;
          response = await deps.fetch(withKey(template, credential.key, "manual"));
          accountID = target.id;
        }
      } catch {
        // Leave the original response in place.
      }
    },

    /**
     * Tells OpenCode not to retry a limit when no account could carry the request anyway. A merely
     * benched account, or one whose usage nobody has read, keeps OpenCode's own retry alive.
     */
    async onRetry(input: RetryInput): Promise<void> {
      try {
        await api.init();
        const status = input.error.status;
        if (status !== 429 && status !== 402) return;
        if (accounts.length === 0) return;
        const now = deps.now();
        const blocked = accounts.every((account) => {
          const kind = classify(account, now).kind;
          return kind === "exhausted" || kind === "invalid-key" || kind === "disabled";
        });
        if (blocked) input.decision = { retry: false };
      } catch {
        // A hook must never fail the request.
      }
    },
  };

  return api;
}

export type Switcher = ReturnType<typeof createSwitcher>;
