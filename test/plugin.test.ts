import { afterEach, describe, expect, test } from "bun:test";
import { Contract } from "../src/rpc.ts";

const KEY_NINE = "fake-key-cooper9-9f8e7d";
const KEY_NINETY_FIVE = "fake-key-cooper95-1a2b3c";

const usagePayload = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 10, resetsAt: "2026-11-18T17:00:00.000Z" },
    weekly: { status: "ok", percent: 20, resetsAt: "2026-11-22T00:00:00.000Z" },
    monthly: { status: "ok", percent: 30, resetsAt: "2026-12-01T00:00:00.000Z" },
  },
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface FakeTool {
  execute: (input: { select?: string }, context: unknown) => Promise<{ content?: string }>;
}

interface FakeContextResult {
  readonly ctx: unknown;
  readonly hooks: Array<{ name: string; options: unknown; run: (input: unknown) => Promise<void> }>;
  tool(): FakeTool;
  readonly activated: string[];
  readonly events: Array<{ name: string; data: unknown }>;
  readonly storage: Map<string, unknown>;
  readonly disposed: string[];
}

function fakeContext(options: Record<string, unknown> = {}): FakeContextResult {
  const hooks: FakeContextResult["hooks"] = [];
  const activated: string[] = [];
  const events: Array<{ name: string; data: unknown }> = [];
  const storage = new Map<string, unknown>();
  const disposed: string[] = [];
  let tool: FakeTool | undefined;

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
        return {
          dispose: async () => {
            disposed.push(name);
          },
        };
      },
    },
    tool: {
      transform: async (apply: (editor: { add: (info: unknown) => void }) => void) => {
        apply({
          add: (info: unknown) => {
            tool = info as FakeTool;
          },
        });
        return {
          dispose: async () => {
            disposed.push("tool");
          },
        };
      },
    },
    rpc: {
      register: async (definition: unknown, _handlers: unknown) => {
        if (definition !== Contract) throw new Error("unexpected contract");
        return {
          events: {
            emit: async (name: string, data: unknown) => {
              events.push({ name, data });
            },
          },
          dispose: async () => {
            disposed.push("rpc");
          },
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

describe("server plugin wiring", () => {
  test("registers provider-scoped hooks, the tool, and the RPC contract", async () => {
    globalThis.fetch = (async () => new Response(usagePayload, { status: 200 })) as unknown as typeof fetch;
    const fake = fakeContext();
    const plugin = await loadServer();

    expect(plugin.id).toBe("opencode-go-autoswitch");
    const cleanup = await plugin.setup(fake.ctx as never);

    expect(fake.hooks.map((hook) => hook.name)).toEqual(["http.request", "http.response"]);
    expect(fake.hooks[0]?.options).toEqual({ providerID: "opencode-go" });
    expect(fake.hooks[1]?.options).toEqual({ providerID: "opencode-go" });

    const text = (await fake.tool().execute({}, {})).content ?? "";
    expect(text).toContain("cooper9");
    expect(text).toContain("cooper95");
    expect(text).not.toContain("fake-key");
    expect(text).not.toContain("other");
    expect(text).not.toContain("OPENCODE_GO_KEY");

    await cleanup?.();
    expect(fake.disposed).toEqual(["http.request", "http.response", "tool", "rpc"]);
  });

  test("puts a resolved key on the outgoing request", async () => {
    globalThis.fetch = (async () => new Response(usagePayload, { status: 200 })) as unknown as typeof fetch;
    const fake = fakeContext();
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    const request = new Request("https://opencode.ai/zen/go/v1/messages", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer managed" },
    });
    const input = { sessionID: "s", agent: "a", model: { providerID: "opencode-go", modelID: "m" }, request };
    await fake.hooks[0]?.run(input);

    expect(request.headers.get("authorization")).toBe("Bearer managed");
    expect(input.request.headers.get("authorization")).not.toBe("Bearer managed");
    expect(input.request.headers.get("authorization")).toMatch(/^Bearer fake-key-/);

    await cleanup?.();
  });

  test("selecting an account activates it, persists it, and emits the RPC event", async () => {
    globalThis.fetch = (async () => new Response(usagePayload, { status: 200 })) as unknown as typeof fetch;
    const fake = fakeContext();
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    const text = (await fake.tool().execute({ select: "cooper95" }, {})).content ?? "";
    expect(text).toContain("current: cooper95 - explicitly selected");
    expect(fake.activated).toEqual(["c95"]);
    expect(fake.storage.get("opencode-go-autoswitch.current")).toBe("c95");
    expect(fake.events).toEqual([{ name: "switched", data: { label: "cooper95", reason: "explicitly selected" } }]);

    for (const value of fake.storage.values()) expect(String(value)).not.toContain("fake-key");

    await cleanup?.();
  });

  test("plugin options override the endpoint and turn toasts off", async () => {
    let requested: string | undefined;
    globalThis.fetch = (async (url: string) => {
      requested = url;
      return new Response(usagePayload, { status: 200 });
    }) as unknown as typeof fetch;
    const fake = fakeContext({ usageUrl: "https://example.test/usage", toast: false });
    const plugin = await loadServer();
    const cleanup = await plugin.setup(fake.ctx as never);

    await fake.tool().execute({ select: "cooper9" }, {});
    expect(requested).toBe("https://example.test/usage");
    expect(fake.activated).toEqual(["c9"]);
    expect(fake.events).toEqual([]);

    await cleanup?.();
  });
});

describe("TUI plugin", () => {
  test("shows a toast for a switch event and unsubscribes on cleanup", async () => {
    const toasts: Array<{ title?: string; message: string }> = [];
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
      ui: { toast: { show: (options: { title?: string; message: string }) => toasts.push(options) } },
    };

    const plugin = (await import("../src/tui.ts")).default;
    const cleanup = await plugin.setup(context as never);

    expect(subscribed).toBe("switched");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toContain("cooper95");
    expect(toasts[0]?.message).toContain("cooper9 monthly limit");
    expect(toasts[0]?.message).not.toContain("fake-key");

    if (typeof cleanup === "function") await cleanup();
    expect(unsubscribed).toBe(true);
  });
});
