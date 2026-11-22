import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_FALLBACK_COOLDOWN_MS,
  DEFAULT_LIMIT_USAGE_BUDGET_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_USAGE_TIMEOUT_MS,
  VERSION,
} from "./defaults.ts";
import { createSwitchingFetch } from "./fetch.ts";
import { createPiAccounts, PROVIDER_ID, withNamedLogin } from "./pi-accounts.ts";
import { createSwitcher } from "./switcher.ts";
import type { Switcher } from "./switcher.ts";
import { DEFAULT_USAGE_URL, fetchUsage } from "./usage.ts";

/** Marks the wrapped provider with the switcher behind it, across separately loaded copies of this module. */
const OWNER = Symbol.for("opencode-go-switch.pi.owner");

type OwnedProvider = Provider & { readonly [OWNER]?: Switcher };

const INACTIVE = "Go Switch is not active in this session.";
const CONFLICT = `Go Switch is off: another extension already replaces the ${PROVIDER_ID} provider.`;

const send = (request: Request): Promise<Response> => globalThis.fetch(request);

function statePath(): string {
  return join(getAgentDir(), "opencode-go-switch.json");
}

async function loadCurrent(): Promise<string | undefined> {
  const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
  const current = (parsed as { current?: unknown } | null)?.current;
  return typeof current === "string" && current !== "" ? current : undefined;
}

/** Replaces the file in one step, because several Pi processes may write it. */
async function saveCurrent(accountID: string): Promise<void> {
  const temporary = `${statePath()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ current: accountID })}\n`, { mode: 0o600 });
    await rename(temporary, statePath());
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Pi's own provider with the switching transport underneath; catalog, protocols, and auth stay Pi's. */
function wrapProvider(original: Provider, switcher: Switcher): OwnedProvider {
  const transport = <T extends { fetch?: typeof globalThis.fetch } | undefined>(options: T): T => {
    const custom = options?.fetch;
    const base = custom === undefined ? send : (request: Request) => custom(request);
    return { ...options, fetch: createSwitchingFetch(switcher, PROVIDER_ID, base) } as T;
  };
  const { apiKey } = original.auth;
  return {
    ...original,
    auth: apiKey === undefined ? original.auth : { ...original.auth, apiKey: withNamedLogin(apiKey) },
    stream: (model, context, options) => original.stream(model, context, transport(options)),
    streamSimple: (model, context, options) => original.streamSimple(model, context, transport(options)),
    [OWNER]: switcher,
  };
}

interface Session {
  readonly switcher: Switcher;
  readonly dispose: () => Promise<void>;
}

function startSession(ctx: ExtensionContext): Session | undefined {
  const registry = ctx.modelRegistry;
  const registered: OwnedProvider | undefined = registry.getRegisteredNativeProvider(PROVIDER_ID);
  const shared = registered?.[OWNER];
  // A child session in the same process: the parent owns the provider and its switcher.
  if (shared !== undefined) return { switcher: shared, dispose: async () => undefined };
  if (registered !== undefined || registry.getRegisteredProviderConfig(PROVIDER_ID) !== undefined) {
    ctx.ui.notify(CONFLICT, "warning");
    return undefined;
  }
  const original = registry.getProvider(PROVIDER_ID);
  if (original === undefined) return undefined;

  const accounts = createPiAccounts(registry);
  const switcher = createSwitcher({
    now: () => Date.now(),
    fetch: send,
    options: {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      usageTimeoutMs: DEFAULT_USAGE_TIMEOUT_MS,
      fallbackCooldownMs: DEFAULT_FALLBACK_COOLDOWN_MS,
      limitUsageBudgetMs: DEFAULT_LIMIT_USAGE_BUDGET_MS,
      version: VERSION,
      connectHint: `Add one with /login ${PROVIDER_ID}.`,
    },
    loadAccounts: () => accounts.load(),
    resolveKey: (accountID) => accounts.resolve(accountID),
    readUsage: (credential) =>
      fetchUsage(credential, {
        fetch: (url, init) => globalThis.fetch(url, init),
        url: DEFAULT_USAGE_URL,
        timeoutMs: DEFAULT_USAGE_TIMEOUT_MS,
      }),
    // Pi has no active credential among several; the transport alone decides.
    activate: async () => undefined,
    loadCurrent,
    saveCurrent,
    notify: (event) => ctx.ui.notify(`Now using ${event.label} (${event.reason})`, "info"),
  });

  const wrapped = wrapProvider(original, switcher);
  registry.registerProvider(wrapped);
  void switcher.start().catch(() => undefined);

  return {
    switcher,
    async dispose() {
      await switcher.stop();
      accounts.dispose();
      if (registry.getRegisteredNativeProvider(PROVIDER_ID) === wrapped) registry.unregisterProvider(PROVIDER_ID);
    },
  };
}

export default function goSwitch(pi: ExtensionAPI): void {
  let session: Session | undefined;

  pi.on("session_start", (_event, ctx) => {
    session = startSession(ctx);
  });

  pi.on("session_shutdown", async () => {
    const ending = session;
    session = undefined;
    await ending?.dispose();
  });

  pi.registerCommand("go-accounts", {
    description: "Show OpenCode Go accounts and their usage; pass an account name to make it current",
    handler: async (args, ctx) => {
      ctx.ui.notify(session === undefined ? INACTIVE : await session.switcher.status(args), "info");
    },
  });

  pi.registerTool({
    name: "go_accounts",
    label: "Go accounts",
    description:
      "List OpenCode Go accounts with their 5h, weekly, and monthly usage, and show which account is current. Pass select with an account label to make that account current; an exhausted, cooling-down, disabled, or invalid-key account is refused.",
    parameters: Type.Object({ select: Type.Optional(Type.String()) }),
    execute: async (_toolCallID, params) => ({
      content: [
        { type: "text", text: session === undefined ? INACTIVE : await session.switcher.status(params.select) },
      ],
      details: undefined,
    }),
  });
}
