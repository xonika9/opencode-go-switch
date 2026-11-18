import { afterEach, describe, expect, test } from "bun:test";
import { Contract } from "../src/rpc.ts";
import { readOptions } from "../src/server.ts";

const KEY_NINE = "fake-key-cooper9-9f8e7d";
const KEY_NINETY_FIVE = "fake-key-cooper95-1a2b3c";

const usagePayload = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 10, resetsAt: "2026-11-18T17:00:00.000Z" },
    weekly: { status: "ok", percent: 20, resetsAt: "2026-11-22T00:00:00.000Z" },
    monthly: { status: "ok", percent: 30, resetsAt: "2026-12-01T00:00:00.000Z" },
  },
});

/** Every window rate limited, so no account has headroom anywhere. */
const exhaustedPayload = JSON.stringify({
  usage: {
    rolling: { status: "rate-limited", percent: 100, resetsAt: "2027-06-01T00:00:00.000Z" },
    weekly: { status: "rate-limited", percent: 100, resetsAt: "2027-06-01T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2027-06-01T00:00:00.000Z" },
  },
});

const packageVersion = async (): Promise<string> => {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
  return pkg.version;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(respond: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: string) => respond(url)) as unknown as typeof fetch;
}

function expectDisposed(actual: readonly string[], expected: readonly string[]): void {
  expect([...actual].sort()).toEqual([...expected].sort());
}

interface FakeTool {
  name: string;
  description: string;
  execute: (input: { select?: string }, context: unknown) => Promise<{ content?: string }>;
}

interface FakeHook {
  name: string;
  options: unknown;
  run: (input: unknown) => Promise<void>;
}

interface FakeContextResult {
  readonly ctx: unknown;
  readonly hooks: FakeHook[];
  tool(): FakeTool;
  readonly activated: string[];
  readonly events: Array<{ name: string; data: unknown }>;
  readonly storage: Map<string, unknown>;
  readonly disposed: string[];
}

interface FakeHost {
  /** Rejects every RPC registration, as a host without the contract would. */
  readonly rpcThrows?: boolean;
  /** A registration whose dispose throws, to prove the others still run. */
  readonly throwOnDispose?: string;
}

function fakeContext(options: Record<string, unknown> = {}, host: FakeHost = {}): FakeContextResult {
  const hooks: FakeHook[] = [];
  const activated: string[] = [];
  const events: Array<{ name: string; data: unknown }> = [];
  const storage = new Map<string, unknown>();
  const disposed: string[] = [];
  let tool: FakeTool | undefined;

  const dispose = (name: string) => async () => {
    disposed.push(name);
    if (name === host.throwOnDispose) throw new Error("dispose exploded");
  };

  const connections = [
    { type: "credential", id: "c9", label: "cooper9", method: "key" },
    { type: "credential", id: "c95", label: "cooper95", method: "key" },
    { type: "env", name: "OPENCODE_GO_KEY" },
    { type: "credential", id: "oauth", label: "other", method: "oauth" },
  ];

  const ctx = {
    options,
    app: { name: "test", version: "0.0.0", channel: "test" },
    location: {},
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      remove: async (key: string) => {
        storage.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    integration: {
      get: async () => ({ location: {}, data: { id: "opencode-go", name: "OpenCode Go", methods: [], connections } }),
      connection: {
        resolve: async (connection: { id?: string }) =>
          connection.id === "c9"
            ? { type: "key", key: KEY_NINE }
            : connection.id === "c95"
              ? { type: "key", key: KEY_NINETY_FIVE }
              : undefined,
        active: async () => undefined,
        status: async () => undefined,
      },
      transform: async () => ({ dispose: async () => undefined }),
      reload: async () => undefined,
    },
    credential: {
      activate: async ({ credentialID }: { credentialID: string }) => {
        activated.push(credentialID);
      },
    },
    session: {
      hook: async (name: string, run: (input: unknown) => Promise<void>, hookOptions: unknown) => {
        hooks.push({ name, options: hookOptions, run });
        return { dispose: dispose(name) };
      },
    },
    tool: {
      transform: async (apply: (editor: { add: (info: unknown) => void }) => void) => {
        apply({
          add: (info: unknown) => {
            tool = info as FakeTool;
          },
        });
        return { dispose: dispose("tool") };
      },
    },
    rpc: {
      register: async (definition: unknown, _handlers: unknown) => {
        if (host.rpcThrows === true) throw new Error("rpc unavailable");
        if (definition !== Contract) throw new Error("unexpected contract");
        return {
          events: {
            emit: async (name: string, data: unknown) => {
              events.push({ name, data });
            },
          },
          dispose: dispose("rpc"),
        };
      },
    },
  };

  return {
    ctx,
    hooks,
    tool: () => {
      if (tool === undefined) throw new Error("tool was not registered");
      return tool;
    },
    activated,
    events,
    storage,
    disposed,
  };
}

async function loadServer() {
  const module = await import("../src/server.ts");
  return module.default;
}

function requestInput(request = new Request("https://opencode.ai/zen/go/v1/messages", {
  method: "POST",
  body: "{}",
  headers: { authorization: "Bearer managed" },
})) {
  return {
    sessionID: "s",
    agent: "a",
    model: { providerID: "opencode-go", modelID: "m" },
    request,
  };
}

function retryInput(status: number) {
  return {
    sessionID: "s",
    agent: "a",
    model: { providerID: "opencode-go", modelID: "m" },
    error: { type: "api", status },
    attempt: 2,
    decision: { retry: true, delay: 500 } as { retry: boolean; delay?: number },
  };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("server plugin wiring", () => {
  test("registers provider-scoped hooks, the tool, and the RPC contract", async () => {
    stubFetch(() => new Response(usagePayload, { status: 200 }));
    const fake = fakeContext();
    const plugin = await loadServer();

    expect(plugin.id).toBe("opencode-go-autoswitch");
    const cleanup = await plugin.setup(fake.ctx as never);

    expect(fake.hooks.map((hook) => hook.name)).toEqual(["http.request", "http.response", "retry"]);
    for (const hook of fake.hooks) expect(hook.options).toEqual({ providerID: "opencode-go" });

    const tool = fake.tool();
    expect(tool.name).toBe("go_accounts");
    expect(tool.description).toContain("5h");
    expect(tool.description).toContain("weekly");
    expect(tool.description).toContain("monthly");
    expect(tool.description).toContain("select");

    const text = (await tool.execute({}, {})).content ?? "";
    expect(text.split("\n")[0]).toBe(`Go Switch ${await packageVersion()}`);
    expect(text).toContain("cooper9");
    expect(text).toContain("cooper95");
    expect(text).not.toContain("fake-key");
    expect(text).not.toContain("other");
    expect(text).not.toContain("OPENCODE_GO_KEY");

    await cleanup?.();
    expectDisposed(fake.disposed, ["http.request", "http.response", "retry", "tool", "rpc"]);
  });

  test("puts a resolved key on the outgoing request", async () => {
    stubFetch(() => new Response(usagePayload, { status: 200 }));
    const fake = fakeContext();
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    const input = requestInput();
    await fake.hooks[0]?.run(input);

    expect(input.request.headers.get("authorization")).not.toBe("Bearer managed");
    expect(input.request.headers.get("authorization")).toMatch(/^Bearer fake-key-/);

    await cleanup?.();
  });

  test("selecting an account activates it, persists it, and emits the RPC event", async () => {
    stubFetch(() => new Response(usagePayload, { status: 200 }));
    const fake = fakeContext();
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    const text = (await fake.tool().execute({ select: "cooper95" }, {})).content ?? "";
    expect(text).toContain("current: cooper95 - explicitly selected");
    expect(fake.activated).toEqual(["c95"]);
    expect(fake.storage.get("opencode-go-autoswitch.current")).toBe("c95");
    expect(fake.events).toEqual([{ name: "switched", data: { label: "cooper95", reason: "explicitly selected" } }]);

    for (const value of fake.storage.values()) expect(String(value)).not.toContain("fake-key");
    expect(JSON.stringify(fake.events)).not.toContain("fake-key");

    await cleanup?.();
  });

  test("plugin options override the endpoint", async () => {
    let requested: string | undefined;
    stubFetch((url) => {
      requested = url;
      return new Response(usagePayload, { status: 200 });
    });
    const fake = fakeContext({ usageUrl: "https://example.test/usage" });
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    await fake.tool().execute({ select: "cooper9" }, {});
    expect(requested).toBe("https://example.test/usage");
    expect(fake.activated).toEqual(["c9"]);
    expect(fake.events).toEqual([{ name: "switched", data: { label: "cooper9", reason: "explicitly selected" } }]);

    await cleanup?.();
  });

  test("invalid option values fall back to the defaults", () => {
    const fallback = readOptions({
      pollIntervalMs: -1,
      usageTimeoutMs: "x",
      fallbackCooldownMs: Number.NaN,
      usageUrl: "",
      integrationID: 12,
      providerID: "   ",
    });
    expect(fallback.pollIntervalMs).toBe(300_000);
    expect(fallback.usageTimeoutMs).toBe(5_000);
    expect(fallback.fallbackCooldownMs).toBe(900_000);
    expect(fallback.usageUrl).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(fallback.integrationID).toBe("opencode-go");
    expect(fallback.providerID).toBe("opencode-go");

    const kept = readOptions({
      pollIntervalMs: 0,
      usageTimeoutMs: 1,
      fallbackCooldownMs: 1_000,
      usageUrl: "https://example.test/usage",
      integrationID: "go-two",
      providerID: "go-two",
    });
    expect(kept.pollIntervalMs).toBe(0);
    expect(kept.usageTimeoutMs).toBe(1);
    expect(kept.fallbackCooldownMs).toBe(1_000);
    expect(kept.usageUrl).toBe("https://example.test/usage");
    expect(kept.integrationID).toBe("go-two");
    expect(kept.providerID).toBe("go-two");
  });

  test("a failed RPC registration leaves the hooks and the tool working", async () => {
    stubFetch(() => new Response(usagePayload, { status: 200 }));
    const fake = fakeContext({}, { rpcThrows: true });
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    expect(fake.hooks.map((hook) => hook.name)).toEqual(["http.request", "http.response", "retry"]);

    const input = requestInput();
    await fake.hooks[0]?.run(input);
    expect(input.request.headers.get("authorization")).toMatch(/^Bearer fake-key-/);

    const text = (await fake.tool().execute({}, {})).content ?? "";
    expect(text.split("\n")[0]).toBe(`Go Switch ${await packageVersion()}`);
    expect(text).toContain("cooper9");
    expect(fake.events).toHaveLength(0);

    await cleanup?.();
    expectDisposed(fake.disposed, ["http.request", "http.response", "retry", "tool"]);
  });

  test("the retry hook declines a limit when every account is confirmed exhausted", async () => {
    stubFetch(() => new Response(exhaustedPayload, { status: 200 }));
    const fake = fakeContext();
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);
    await fake.tool().execute({}, {});

    const retry = fake.hooks.find((hook) => hook.name === "retry");
    const limited = retryInput(429);
    await retry?.run(limited);
    expect(limited.decision).toEqual({ retry: false });

    const serverError = retryInput(500);
    await retry?.run(serverError);
    expect(serverError.decision).toEqual({ retry: true, delay: 500 });

    await cleanup?.();
  });

  test("the retry hook leaves the decision alone while an account still has headroom", async () => {
    stubFetch(() => new Response(usagePayload, { status: 200 }));
    const fake = fakeContext();
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);
    await fake.tool().execute({}, {});

    const retry = fake.hooks.find((hook) => hook.name === "retry");
    const limited = retryInput(429);
    await retry?.run(limited);
    expect(limited.decision).toEqual({ retry: true, delay: 500 });

    await cleanup?.();
  });

  test("cleanup disposes every registration and stops polling, even when one dispose throws", async () => {
    let polls = 0;
    stubFetch(() => {
      polls += 1;
      return new Response(usagePayload, { status: 200 });
    });
    const fake = fakeContext({ pollIntervalMs: 10 }, { throwOnDispose: "http.request" });
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    await waitFor(() => polls >= 4, 3_000);
    expect(polls).toBeGreaterThanOrEqual(4);
    expect(fake.disposed).toEqual([]);

    await cleanup?.();
    expectDisposed(fake.disposed, ["http.request", "http.response", "retry", "tool", "rpc"]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterCleanup = polls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(polls).toBe(afterCleanup);
  });
});

describe("TUI plugin", () => {
  test("shows a Go Switch toast for a switched event and unsubscribes on cleanup", async () => {
    const toasts: Array<{ title?: string; message: string; variant?: string }> = [];
    let subscribed: string | undefined;
    let unsubscribed = false;

    const context = {
      options: {},
      client: {
        rpc: (definition: unknown) => {
          if (definition !== Contract) throw new Error("unexpected contract");
          return {
            events: {
              on: (name: string, handler: (event: { data: { label: string; reason: string } }) => void) => {
                subscribed = name;
                handler({ data: { label: "cooper95", reason: "cooper9 monthly limit" } });
                return () => {
                  unsubscribed = true;
                };
              },
            },
          };
        },
      },
      ui: { toast: { show: (options: { title?: string; message: string; variant?: string }) => toasts.push(options) } },
    };

    const plugin = (await import("../src/tui.ts")).default;
    const cleanup = await plugin.setup(context as never);

    expect(subscribed).toBe("switched");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toEqual({
      title: "Go Switch",
      message: "Now using cooper95 (cooper9 monthly limit)",
      variant: "info",
    });
    expect(JSON.stringify(toasts)).not.toContain("fake-key");

    expect(typeof cleanup).toBe("function");
    await cleanup?.();
    expect(unsubscribed).toBe(true);
  });
});
