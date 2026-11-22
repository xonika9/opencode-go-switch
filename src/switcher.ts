import {
  anyWindowLimited,
  causeOf,
  classify,
  confirmedOut,
  exhaustedWindow,
  isUsable,
  pickNext,
  usableAsCurrent,
} from "./select.ts";
import { formatAmbiguousLabel, formatRefusal, formatStatus, formatUnknownLabel } from "./status.ts";
import type { LastSwitch } from "./status.ts";
import { createAccount } from "./types.ts";
import type { Account, AccountInfo, Usage } from "./types.ts";
import type { UsageCredential, UsageResult } from "./usage.ts";
import { retryAfterMs } from "./usage.ts";

export interface SwitcherOptions {
  readonly pollIntervalMs: number;
  readonly fallbackCooldownMs: number;
  /** How long the first request waits for the startup usage poll. */
  readonly usageTimeoutMs: number;
  /** How long a usage read may take before a limit is handled as if usage were unknown. */
  readonly limitUsageBudgetMs: number;
  readonly version: string;
  /** Where to connect an account, printed when none is connected. */
  readonly connectHint: string;
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
  /** Sends the retries of this request; `deps.fetch` when absent. */
  readonly fetch?: (request: Request) => Promise<Response>;
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

type IntervalHandle = ReturnType<typeof setInterval> & { unref?: () => void };

const STICKY = "sticky: still has headroom";
const STICKY_UNKNOWN = "sticky: usage unknown";
const STARTUP = "startup: earliest monthly reset";
const EXPLICIT = "explicitly selected";
const RESTORED = "restored from storage";

/** Headers that carry the bare key: Anthropic's and Google's. */
const KEY_HEADERS = ["x-api-key", "x-goog-api-key"] as const;

/**
 * Puts the key on the request in whichever header the caller already uses, so the provider keeps
 * accepting it and no other account's key stays behind. A request with none of them gets an
 * authorization header.
 */
function withKey(request: Request, key: string, redirect?: RequestRedirect): Request {
  const headers = new Headers(request.headers);
  const used = KEY_HEADERS.filter((name) => headers.has(name));
  for (const name of used) headers.set(name, key);
  if (used.length === 0 || headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
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
  let currentReason = "not chosen yet";
  let lastSwitch: LastSwitch | null = null;
  let ready: Promise<void> | null = null;
  let startupPoll: Promise<void> | null = null;
  let timer: IntervalHandle | null = null;
  let polling: Promise<void> | null = null;
  let deciding: Promise<unknown> = Promise.resolve();
  let starting: Promise<void> | null = null;
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

  function recordUsage(account: Account, usage: Usage, now: number): void {
    account.usage = usage;
    account.checkedAt = now;
    account.invalidKey = false;
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
          recordUsage(account, result.usage, now);
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
    const stored = await deps.loadCurrent().catch(() => undefined);
    if (stored !== undefined && accounts.some((account) => account.id === stored)) {
      current = stored;
      currentReason = RESTORED;
    }
  }

  function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      let limit: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        if (limit !== undefined) clearTimeout(limit);
        resolve(value);
      };
      limit = setTimeout(() => finish(onTimeout()), Math.max(0, ms));
      promise.then(finish, () => finish(onTimeout()));
    });
  }

  /** Waits for the startup poll, but never longer than the usage timeout. */
  function awaitStartupUsage(): Promise<void> {
    return withDeadline(startupPoll ?? refresh(), deps.options.usageTimeoutMs, () => undefined);
  }

  /** Runs a decision alone, so two failures cannot both switch and both announce it. */
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = deciding.then(work, work);
    deciding = run.catch(() => undefined);
    return run;
  }

  async function ignoreFailure(work: () => Promise<void> | void): Promise<void> {
    try {
      await work();
    } catch {
      return;
    }
  }

  async function switchTo(account: Account, reason: string, cause: string): Promise<void> {
    const previous = currentAccount()?.label ?? null;
    current = account.id;
    currentReason = reason;
    lastSwitch = { from: previous, to: account.label, cause, at: deps.now() };
    await ignoreFailure(() => deps.saveCurrent(account.id));
    await ignoreFailure(() => deps.activate(account.id));
    await ignoreFailure(() => deps.notify({ label: account.label, reason: cause }));
  }

  /** Frees the body of a retry response nobody will read. */
  function release(response: Response): void {
    void response.body?.cancel().catch(() => undefined);
  }

  function markInvalid(id: string | null): void {
    const account = find(id);
    if (account !== undefined) account.invalidKey = true;
  }

  async function keyFor(id: string): Promise<UsageCredential | undefined> {
    let credential: UsageCredential | undefined;
    try {
      credential = await deps.resolveKey(id);
    } catch {
      // A store that failed to answer says nothing about the key itself.
      return undefined;
    }
    if (credential === undefined || credential.key === "") {
      markInvalid(id);
      return undefined;
    }
    return credential;
  }

  /** Reads usage without letting a slow endpoint hold the request for longer than the budget. */
  function readUsageBounded(credential: UsageCredential, onTimeout: () => void): Promise<UsageResult> {
    return withDeadline(
      deps.readUsage(credential).catch((): UsageResult => ({ type: "unavailable" })),
      deps.options.limitUsageBudgetMs,
      () => {
        onTimeout();
        return { type: "unavailable" };
      },
    );
  }

  /** Per-request memory of a usage endpoint that already ran out its budget once. */
  interface LimitReads {
    slow: boolean;
  }

  /**
   * Applies a 429/402 to one account. Returns false when a fresh usage read says the account still
   * has headroom in every window (so the limit was not ours and the response should stand).
   */
  async function noteLimit(id: string | null, response: Response, reads: LimitReads): Promise<boolean> {
    const account = find(id);
    if (account === undefined) return true;
    const credential = await keyFor(account.id);
    if (credential === undefined) return true;
    const now = deps.now();
    // Once the endpoint has timed out in this request, the next account would only wait out the same
    // budget before reaching the same cooldown, so it goes there directly.
    const result: UsageResult = reads.slow
      ? { type: "unavailable" }
      : await readUsageBounded(credential, () => {
          reads.slow = true;
        });
    if (result.type === "usage") {
      recordUsage(account, result.usage, now);
      if (exhaustedWindow(result.usage, now) !== null) {
        void refresh();
        return true;
      }
      // Real headroom: the limit did not come from a Go window, so the response stands.
      if (!anyWindowLimited(result.usage)) return false;
      // A window is still flagged although its reset has passed; set the account aside like any
      // unexplained limit rather than leaving the request on it.
    }
    if (result.type === "invalid-key") {
      account.invalidKey = true;
      return true;
    }
    const wait = retryAfterMs(response.headers.get("retry-after"), now);
    account.cooldownUntil = now + (wait ?? deps.options.fallbackCooldownMs);
    void refresh();
    return true;
  }

  async function refreshIfStale(): Promise<boolean> {
    const now = deps.now();
    const stale = accounts.some(
      (account) => account.checkedAt === null || now - account.checkedAt >= deps.options.pollIntervalMs,
    );
    if (!stale) return false;
    await refresh();
    return true;
  }

  function statusText(): string {
    return formatStatus({
      version: deps.options.version,
      connectHint: deps.options.connectHint,
      accounts,
      currentID: current,
      reason: currentReason,
      lastSwitch,
      now: deps.now(),
    });
  }

  /** Makes the named account current, or returns the refusal to print above the status. */
  async function selectByLabel(wanted: string): Promise<string | null> {
    const lower = wanted.toLowerCase();
    const matches = accounts.filter((account) => account.label.toLowerCase() === lower);
    if (matches.length === 0) {
      return formatUnknownLabel(
        wanted,
        accounts.map((account) => account.label),
      );
    }
    if (matches.length > 1) {
      return formatAmbiguousLabel(
        wanted,
        matches.map((account) => account.label),
      );
    }
    const target = matches[0]!;
    const now = deps.now();
    const state = classify(target, now);
    if (!isUsable(state)) return formatRefusal(target.label, state, now);
    if (target.id !== current) await switchTo(target, EXPLICIT, EXPLICIT);
    return null;
  }

  async function begin(): Promise<void> {
    await api.init();
    if (timer === null && deps.options.pollIntervalMs > 0) {
      timer = setInterval(() => {
        void refresh();
      }, deps.options.pollIntervalMs);
      timer.unref?.();
    }
    void (startupPoll ?? refresh());
  }

  const api = {
    /** Loads accounts and the persisted current account. Safe to call repeatedly. */
    init(): Promise<void> {
      ready ??= boot();
      return ready;
    },

    /** Loads state, then polls usage in the background and keeps polling. */
    start(): Promise<void> {
      starting ??= begin();
      return starting;
    },

    async stop(): Promise<void> {
      await starting?.catch(() => undefined);
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    /** Polls every account now, coalescing with a poll already in flight. */
    refresh(): Promise<void> {
      return refresh();
    },

    /** Text for the `go_accounts` tool; with `label`, makes that account current first. */
    async status(label?: string): Promise<string> {
      await api.init();
      if (!(await refreshIfStale())) {
        await syncAccounts().catch(() => undefined);
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
          // Another request may have picked while this one waited; reuse its choice.
          const chosen = currentAccount();
          if (chosen !== undefined && usableAsCurrent(chosen, deps.now())) {
            account = chosen;
          } else {
            const picked = pickNext(accounts, deps.now());
            if (picked === undefined) return;
            await switchTo(picked, STARTUP, STARTUP);
            account = picked;
          }
        } else {
          const now = deps.now();
          const state = classify(account, now);
          if (isUsable(state)) {
            currentReason = state.kind === "eligible" ? STICKY : STICKY_UNKNOWN;
          } else {
            const next = pickNext(accounts, now);
            if (next === undefined) return;
            const cause = causeOf(account, state);
            await switchTo(next, `switched: ${cause}`, cause);
            account = next;
          }
        }

        const credential = await keyFor(account.id);
        if (credential === undefined) return;
        const replaced = withKey(input.request, credential.key);
        requests.set(replaced, {
          accountID: account.id,
          tried: new Set([account.id]),
          template: replaced.body === null ? undefined : cloneRequest(replaced),
        });
        input.request = replaced;
      } catch {
        return;
      }
    },

    /**
     * Retries a limit or auth failure with the next account inside the same hook call. The first
     * response stands when no account is left to try.
     */
    async onResponse(input: HttpResponseInput): Promise<void> {
      const first = input.response;
      let response = first;
      try {
        await api.init();
        const state = requests.get(input.request);
        try {
          const base = state?.template ?? cloneRequest(input.request);
          if (base === undefined) return;
          const tried = new Set<string>(state?.tried ?? []);
          let accountID = state?.accountID ?? current;
          const reads: LimitReads = { slow: false };

          for (let step = 0; step <= accounts.length; step++) {
            if (response.status === 403) {
              if (response !== first) input.response = response;
              return;
            }
            if (response.status === 401) {
              markInvalid(accountID);
            } else if (response.status === 429 || response.status === 402) {
              if (!(await noteLimit(accountID, response, reads))) {
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

            const credential = await keyFor(target.id);
            if (credential === undefined) return;
            const template = cloneRequest(base);
            if (template === undefined) return;
            const superseded = response;
            response = await (input.fetch ?? deps.fetch)(withKey(template, credential.key, "manual"));
            if (superseded !== first) release(superseded);
            accountID = target.id;
          }
        } finally {
          requests.delete(input.request);
          if (response !== first && input.response !== response) release(response);
        }
      } catch {
        return;
      }
    },

    /**
     * Tells OpenCode not to retry a limit when no account could carry the request anyway. A merely
     * cooling-down account, or one whose usage nobody has read, keeps OpenCode's own retry alive.
     */
    async onRetry(input: RetryInput): Promise<void> {
      try {
        await api.init();
        const status = input.error.status;
        if (status !== 429 && status !== 402) return;
        if (accounts.length === 0) return;
        const now = deps.now();
        if (accounts.every((account) => confirmedOut(account, now))) input.decision = { retry: false };
      } catch {
        return;
      }
    },
  };

  return api;
}

export type Switcher = ReturnType<typeof createSwitcher>;
