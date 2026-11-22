import type { ApiKeyAuth, AuthResult, Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AccountInfo } from "./types.ts";

export const PROVIDER_ID = "opencode-go";
/** Accounts Pi can hold: its own OpenCode Go login plus the extra slots. */
const MAX_ACCOUNTS = 20;
/** Where the account name lives in a Pi credential, beside the key. */
const LABEL_ENV = "OPENCODE_GO_LABEL";

type Registry = Pick<
  ModelRegistry,
  "getProviderAuth" | "getProviderAuthStatus" | "registerProvider" | "unregisterProvider"
>;

/** Login that asks for the account's name as well as its key. */
export function withNamedLogin(auth: ApiKeyAuth): ApiKeyAuth {
  return {
    ...auth,
    async login(interaction) {
      const label = (
        await interaction.prompt({ type: "text", message: "Account name (shown in /go-accounts)" })
      ).trim();
      const key = (await interaction.prompt({ type: "secret", message: "OpenCode Go API key" })).trim();
      if (key === "") throw new Error("No API key entered");
      return label === ""
        ? { type: "api_key", key }
        : { type: "api_key", key, env: { [LABEL_ENV]: label } };
    },
  };
}

/** A provider without models: it exists so that `/login` can store one more key. */
function createSlot(id: string, number: number): Provider {
  const refuse = (): never => {
    throw new Error(`${id} only stores an account; use a model of ${PROVIDER_ID}`);
  };
  return {
    id,
    name: `OpenCode Go (account ${number})`,
    auth: {
      apiKey: withNamedLogin({
        name: "OpenCode Go API key",
        resolve: async ({ credential }) =>
          credential?.key === undefined
            ? undefined
            : {
                auth: { apiKey: credential.key },
                ...(credential.env === undefined ? {} : { env: credential.env }),
                source: "stored credential",
              },
      }),
    },
    getModels: () => [],
    stream: refuse,
    streamSimple: refuse,
  };
}

/**
 * The Go accounts Pi has stored. Pi keeps one credential per provider, so accounts after the first live
 * under slot providers named `opencode-go-2`, `opencode-go-3`, and so on.
 */
export function createPiAccounts(registry: Registry) {
  const slots = new Set<string>();

  /** Registers every slot that holds a key, plus one free slot to log the next account in to. */
  function syncSlots(): string[] {
    const connected: string[] = [];
    let offered = false;
    for (let number = 2; number <= MAX_ACCOUNTS; number++) {
      const id = `${PROVIDER_ID}-${number}`;
      const configured = registry.getProviderAuthStatus(id).configured;
      if (configured) connected.push(id);
      else if (offered) continue;
      else offered = true;
      if (slots.has(id)) continue;
      slots.add(id);
      registry.registerProvider(createSlot(id, number));
    }
    return connected;
  }

  return {
    async load(): Promise<readonly AccountInfo[]> {
      const infos: AccountInfo[] = [];
      for (const id of [PROVIDER_ID, ...syncSlots()]) {
        let auth: AuthResult | undefined;
        try {
          auth = await registry.getProviderAuth(id);
        } catch {
          // A key that could not be read right now is still an account.
          infos.push({ id, label: id, disabled: false });
          continue;
        }
        if (auth === undefined) continue;
        const label = auth.env?.[LABEL_ENV]?.trim() ?? "";
        infos.push({ id, label: label === "" ? id : label, disabled: false });
      }
      return infos;
    },

    async resolve(id: string): Promise<{ key: string } | undefined> {
      const key = (await registry.getProviderAuth(id))?.auth.apiKey;
      return key === undefined ? undefined : { key };
    },

    dispose(): void {
      for (const id of slots) registry.unregisterProvider(id);
      slots.clear();
    },
  };
}
