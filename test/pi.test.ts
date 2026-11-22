import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Api, ApiKeyCredential, AuthPrompt, Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import goSwitch from "../src/pi.ts";

/*
 * The registry, the provider, and the protocol adapters are Pi's own; only the extension host around
 * them and the network are fake.
 */

const GO = "opencode-go";
const SECOND = "opencode-go-2";
const KEY_ONE = "fake-key-one-9f8e7d";
const KEY_TWO = "fake-key-two-1a2b3c";
const LIMIT = JSON.stringify({
  type: "error",
  error: { type: "GoUsageLimitError", message: "Monthly usage limit reached" },
});

/** One model per protocol, with the header that protocol authenticates by. */
const PROTOCOLS = [
  ["openai-completions", "authorization"],
  ["openai-responses", "authorization"],
  ["anthropic-messages", "x-api-key"],
  ["google-generative-ai", "x-goog-api-key"],
] as const;

type Handler = (event: unknown, ctx: unknown) => unknown;

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir = "";
const running: Array<() => Promise<void>> = [];

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "go-switch-pi-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

interface Sent {
  readonly path: string;
  readonly headers: Headers;
  readonly body: string;
}

/** The Go endpoint: usage for every key, and a 429 for keys whose monthly window is out. */
function fakeGo(limited: Set<string>): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "opencode.ai") throw new Error(`unexpected host ${url.hostname}`);
    const key =
      request.headers.get("x-goog-api-key") ??
      request.headers.get("x-api-key") ??
      (request.headers.get("authorization") ?? "").replace("Bearer ", "");
    if (url.pathname.endsWith("/usage")) {
      const open = { status: "ok", percent: 10, resetsAt: "2099-01-01T00:00:00.000Z" };
      // The first account resets sooner, so it is the one a fresh start chooses.
      const resetsAt = key === KEY_ONE ? "2098-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z";
      const monthly = limited.has(key)
        ? { status: "rate-limited", percent: 100, resetsAt }
        : { status: "ok", percent: 10, resetsAt };
      return Response.json({ usage: { rolling: open, weekly: open, monthly } });
    }
    sent.push({ path: url.pathname, headers: request.headers, body: await request.text() });
    return limited.has(key)
      ? new Response(LIMIT, { status: 429, headers: { "content-type": "application/json" } })
      : new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return sent;
}

function credential(key: string, label?: string): ApiKeyCredential {
  return label === undefined
    ? { type: "api_key", key }
    : { type: "api_key", key, env: { OPENCODE_GO_LABEL: label } };
}

const BOTH = { [GO]: credential(KEY_ONE, "one"), [SECOND]: credential(KEY_TWO, "two") };

async function createRuntime(credentials: Readonly<Record<string, ApiKeyCredential>>) {
  const store = new InMemoryCredentialStore();
  for (const [id, value] of Object.entries(credentials)) await store.modify(id, async () => value);
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, allowModelNetwork: false });
  return { store, runtime, registry: new ModelRegistry(runtime) };
}

/** Loads the extension into a session over the given registry. */
function loadExtension(registry: ModelRegistry) {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let tool: ((id: string, params: { select?: string }) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  const ctx = {
    modelRegistry: registry,
    ui: { notify: (message: string) => notifications.push(message) },
  };
  goSwitch({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, options: { handler: typeof command }) => {
      command = options.handler;
    },
    registerTool: (definition: { execute: typeof tool }) => {
      tool = definition.execute;
    },
  } as unknown as Parameters<typeof goSwitch>[0]);
  const stop = async (): Promise<void> => {
    await handlers.get("session_shutdown")?.({}, ctx);
  };
  running.push(stop);
  return {
    notifications,
    stop,
    start: async () => {
      await handlers.get("session_start")?.({}, ctx);
    },
    command: async (args = "") => {
      await command?.(args, ctx);
      return notifications.at(-1) ?? "";
    },
    tool: async (params: { select?: string } = {}) => (await tool?.("call", params))?.content[0]?.text ?? "",
  };
}

async function startedWith(credentials: Readonly<Record<string, ApiKeyCredential>>) {
  const runtime = await createRuntime(credentials);
  const extension = loadExtension(runtime.registry);
  await extension.start();
  return { ...runtime, ...extension };
}

function modelOf(registry: ModelRegistry, api: string = "openai-completions"): Model<Api> {
  const model = registry.getAll().find((candidate) => candidate.provider === GO && candidate.api === api);
  if (model === undefined) throw new Error(`no ${api} model in Pi's catalog`);
  return model;
}

async function ask(registry: ModelRegistry, model = modelOf(registry)) {
  return await registry
    .streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] })
    .result();
}

describe("requests", () => {
  test.each(PROTOCOLS)("%s: a limit re-sends the same request with the next account's key", async (api, header) => {
    const limited = new Set<string>();
    const sent = fakeGo(limited);
    const { registry, notifications, command } = await startedWith(BOTH);
    await command();

    await ask(registry, modelOf(registry, api));
    limited.add(KEY_ONE);
    await ask(registry, modelOf(registry, api));

    const value = (key: string): string => (header === "authorization" ? `Bearer ${key}` : key);
    expect(sent.map((request) => request.headers.get(header))).toEqual([KEY_ONE, KEY_ONE, KEY_TWO].map(value));
    expect(sent[2]!.path).toBe(sent[1]!.path);
    expect(sent[2]!.body).toBe(sent[1]!.body);
    expect(JSON.stringify([...sent[2]!.headers])).not.toContain(KEY_ONE);
    expect(notifications.at(-1)).toBe("Now using two (one monthly limit)");
  });

  test("when every account is limited, Pi gets the provider's own error after one try each", async () => {
    const limited = new Set<string>();
    const sent = fakeGo(limited);
    const { registry, command } = await startedWith(BOTH);
    await command();
    limited.add(KEY_ONE).add(KEY_TWO);

    const message = await ask(registry);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Monthly usage limit reached");
    expect(sent.map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${KEY_ONE}`,
      `Bearer ${KEY_TWO}`,
    ]);
  });

  test("a caller's own fetch carries the retry too", async () => {
    const limited = new Set([KEY_ONE]);
    const sent = fakeGo(new Set());
    const { registry, command } = await startedWith(BOTH);
    await command();
    const carried: Array<string | null> = [];

    await registry
      .streamSimple(
        modelOf(registry),
        { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        {
          fetch: (async (input: Request) => {
            const key = input.headers.get("authorization")?.replace("Bearer ", "") ?? null;
            carried.push(key);
            if (key === null || !limited.has(key)) return new Response("data: [DONE]\n\n");
            return new Response(LIMIT, { status: 401 });
          }) as typeof fetch,
        },
      )
      .result();

    expect(carried).toEqual([KEY_ONE, KEY_TWO]);
    expect(sent).toEqual([]);
  });

  test("the account in use is remembered by the next session", async () => {
    const sent = fakeGo(new Set());
    const first = await startedWith(BOTH);
    await first.command("two");
    await first.stop();

    const second = await startedWith(BOTH);
    await ask(second.registry);

    expect(sent.map((request) => request.headers.get("authorization"))).toEqual([`Bearer ${KEY_TWO}`]);
  });

  test("a damaged state file does not stop requests and is replaced by the next choice", async () => {
    await writeFile(join(agentDir, "opencode-go-switch.json"), "{");
    const sent = fakeGo(new Set());
    const { registry } = await startedWith(BOTH);

    await ask(registry);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(await readFile(join(agentDir, "opencode-go-switch.json"), "utf8"))).toEqual({ current: GO });
  });
});

describe("accounts", () => {
  test("logging in to the free slot adds a named account and offers the next slot", async () => {
    const sent = fakeGo(new Set());
    const { runtime, registry, command, tool } = await startedWith({ [GO]: credential(KEY_ONE, "one") });
    expect(await command()).toContain("OpenCode Go accounts (1 connected)");
    expect(registry.getProvider("opencode-go-3")).toBeUndefined();

    const answers: Record<string, string> = { text: " two ", secret: KEY_TWO };
    await runtime.login(SECOND, "api_key", {
      prompt: async (prompt: AuthPrompt) => answers[prompt.type] ?? "",
      notify: () => undefined,
    });

    expect(await tool({ select: "two" })).toContain("current: two - explicitly selected");
    expect(registry.getProvider("opencode-go-3")).toBeDefined();
    await ask(registry);
    expect(sent.map((request) => request.headers.get("authorization"))).toEqual([`Bearer ${KEY_TWO}`]);
  });

  test("an account behind a gap in the slots is still connected", async () => {
    fakeGo(new Set());
    const { command } = await startedWith({
      [GO]: credential(KEY_ONE, "one"),
      "opencode-go-4": credential(KEY_TWO, "four"),
    });

    const text = await command();

    expect(text).toContain("OpenCode Go accounts (2 connected)");
    expect(text).toContain("four - eligible");
  });

  test("an unnamed account goes by its provider id, and no key is ever printed", async () => {
    fakeGo(new Set());
    const { command } = await startedWith({ [GO]: credential(KEY_ONE), [SECOND]: credential(KEY_TWO) });

    const text = await command();

    expect(text).toContain(`${GO} - eligible`);
    expect(text).toContain(`${SECOND} - eligible`);
    expect(text).not.toContain(KEY_ONE);
    expect(text).not.toContain(KEY_TWO);
  });

  test("with no key connected the status says how to connect one", async () => {
    fakeGo(new Set());
    const { command } = await startedWith({});

    expect(await command()).toContain("No OpenCode Go keys are connected. Add one with /login opencode-go.");
  });
});

describe("provider registration", () => {
  test("keeps Pi's catalog and is undone when the session ends", async () => {
    fakeGo(new Set());
    const { registry } = await createRuntime(BOTH);
    const before = registry.getProvider(GO);
    const ids = registry.getAll().filter((model) => model.provider === GO).map((model) => model.id);
    const extension = loadExtension(registry);

    await extension.start();
    expect(registry.getProvider(GO)).not.toBe(before);
    expect(registry.getAll().filter((model) => model.provider === GO).map((model) => model.id)).toEqual(ids);
    expect(registry.getProvider(SECOND)).toBeDefined();

    await extension.stop();
    expect(registry.getProvider(GO)).toBe(before);
    expect(registry.getProvider(SECOND)).toBeUndefined();
  });

  test("a child session on the same registry shares the parent's account and leaves it in place", async () => {
    const sent = fakeGo(new Set());
    const { registry } = await createRuntime(BOTH);
    const parent = loadExtension(registry);
    await parent.start();
    const child = loadExtension(registry);
    await child.start();

    expect(await child.command("two")).toContain("current: two");
    await child.stop();
    await ask(registry);

    expect(sent.map((request) => request.headers.get("authorization"))).toEqual([`Bearer ${KEY_TWO}`]);
    expect(await parent.command()).toContain("current: two");
  });

  test("steps aside when another extension already replaces the provider", async () => {
    const sent = fakeGo(new Set());
    const { registry } = await createRuntime(BOTH);
    registry.registerProvider(GO, { headers: { "x-other": "1" } });
    const extension = loadExtension(registry);
    await extension.start();

    expect(extension.notifications).toEqual([
      "Go Switch is off: another extension already replaces the opencode-go provider.",
    ]);
    await extension.stop();
    await ask(registry);
    expect(sent[0]!.headers.get("x-other")).toBe("1");
    expect(await extension.tool()).toBe("Go Switch is not active in this session.");
  });
});
