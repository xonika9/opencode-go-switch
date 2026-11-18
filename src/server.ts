import { readFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { Contract } from "./rpc.ts";
import { createSwitcher } from "./switcher.ts";
import type { SwitcherOptions } from "./switcher.ts";
import type { AccountInfo } from "./types.ts";
import { DEFAULT_USAGE_URL, fetchUsage } from "./usage.ts";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
type IntegrationConnection = Awaited<ReturnType<Context["integration"]["get"]>>["data"]["connections"][number];
type Disposable = { dispose: () => Promise<void> | void };

const STORAGE_KEY = "opencode-go-autoswitch.current";
const DEFAULT_POLL_INTERVAL_MS = 300_000;
const DEFAULT_USAGE_TIMEOUT_MS = 5_000;
const DEFAULT_FALLBACK_COOLDOWN_MS = 900_000;
const DEFAULT_LIMIT_USAGE_BUDGET_MS = 2_000;
const UNKNOWN_VERSION = "unknown";

const toolInput = Schema.Struct({ select: Schema.optional(Schema.String) });

interface Options extends SwitcherOptions {
  readonly usageUrl: string;
  readonly integrationID: string;
  readonly providerID: string;
}

/**
 * The package's own version, read from the file beside the module. Both `src/` and `dist/` sit one
 * directory below the package root, which is why the import graph must not carry package.json: it
 * lives outside the build's rootDir.
 */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return UNKNOWN_VERSION;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.trim() !== "" ? version.trim() : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

const VERSION = readVersion();

function numberOption(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

function stringOption(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value.trim();
}

export function readOptions(raw: Readonly<Record<string, unknown>>): Options {
  return {
    pollIntervalMs: numberOption(raw.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 0),
    usageTimeoutMs: numberOption(raw.usageTimeoutMs, DEFAULT_USAGE_TIMEOUT_MS, 1),
    fallbackCooldownMs: numberOption(raw.fallbackCooldownMs, DEFAULT_FALLBACK_COOLDOWN_MS, 0),
    limitUsageBudgetMs: DEFAULT_LIMIT_USAGE_BUDGET_MS,
    usageUrl: stringOption(raw.usageUrl, DEFAULT_USAGE_URL),
    integrationID: stringOption(raw.integrationID, "opencode-go"),
    providerID: stringOption(raw.providerID, "opencode-go"),
    version: VERSION,
  };
}

export default Plugin.define({
  id: "opencode-go-autoswitch",
  async setup(ctx) {
    const options = readOptions(ctx.options);
    const connections = new Map<string, IntegrationConnection>();
    const disposers: Array<() => Promise<void> | void> = [];
    let emitSwitch: ((event: { label: string; reason: string }) => Promise<void>) | undefined;

    const switcher = createSwitcher({
      now: () => Date.now(),
      fetch: (request) => globalThis.fetch(request),
      options,
      loadAccounts: async (): Promise<readonly AccountInfo[]> => {
        const result = await ctx.integration.get({ integrationID: options.integrationID });
        connections.clear();
        const infos: AccountInfo[] = [];
        for (const connection of result.data.connections) {
          if (connection.type !== "credential" || connection.method !== "key") continue;
          connections.set(connection.id, connection);
          const label = connection.label.trim();
          infos.push({
            id: connection.id,
            label: label === "" ? connection.id : label,
            disabled: connection.status !== undefined,
          });
        }
        return infos;
      },
      resolveKey: async (accountID) => {
        const connection = connections.get(accountID);
        if (connection === undefined) return undefined;
        const value = await ctx.integration.connection.resolve(connection);
        if (value?.type !== "key") return undefined;
        return { key: value.key, metadata: value.metadata };
      },
      readUsage: (credential) =>
        fetchUsage(credential, {
          fetch: (url, init) => globalThis.fetch(url, init),
          url: options.usageUrl,
          timeoutMs: options.usageTimeoutMs,
        }),
      activate: (accountID) => ctx.credential.activate({ credentialID: accountID }),
      loadCurrent: async () => {
        const value = await ctx.storage.get(STORAGE_KEY);
        return typeof value === "string" && value !== "" ? value : undefined;
      },
      saveCurrent: (accountID) => ctx.storage.set(STORAGE_KEY, accountID),
      notify: async (event) => {
        await emitSwitch?.(event);
      },
    });

    const addHook = async (register: () => Promise<Disposable>): Promise<void> => {
      const hook = await register();
      disposers.push(() => hook.dispose());
    };

    try {
      await addHook(() =>
        ctx.session.hook("http.request", (input) => switcher.onRequest(input), {
          providerID: options.providerID,
        }),
      );

      await addHook(() =>
        ctx.session.hook("http.response", (input) => switcher.onResponse(input), {
          providerID: options.providerID,
        }),
      );

      await addHook(() =>
        ctx.session.hook("retry", (input) => switcher.onRetry(input), {
          providerID: options.providerID,
        }),
      );

      const tool = await ctx.tool.transform((editor) => {
        editor.add({
          name: "go_accounts",
          description:
            "List OpenCode Go accounts with their 5h, weekly, and monthly usage, and show which account is current. Pass select with an account label to make that account current; an exhausted, cooling-down, disabled, or invalid-key account is refused.",
          input: toolInput,
          execute: async (value) => ({ content: await switcher.status(value.select) }),
        });
      });
      disposers.push(() => tool.dispose());

      const rpc = await Promise.resolve()
        .then(() => ctx.rpc.register(Contract, {}))
        .catch(() => undefined);
      if (rpc !== undefined) {
        emitSwitch = (event) => rpc.events.emit("switched", { label: event.label, reason: event.reason });
        disposers.push(() => rpc.dispose());
      }

      void switcher.start().catch(() => undefined);
    } catch (error) {
      await switcher.stop();
      throw error;
    }

    return async () => {
      await switcher.stop();
      await Promise.allSettled(disposers.map((dispose) => Promise.resolve().then(dispose)));
    };
  },
});
