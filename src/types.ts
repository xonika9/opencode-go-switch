export type WindowName = "rolling" | "weekly" | "monthly";

/** One Go subscription window as reported by the usage endpoint. */
export interface UsageWindow {
  /** Share of the window already used, in percent. */
  readonly percent: number;
  /** The endpoint says the window is rate limited, or usage reached 100%. */
  readonly limited: boolean;
  /** Reset time in ms since the epoch, or null when the endpoint did not give a usable one. */
  readonly resetsAt: number | null;
}

export interface Usage {
  readonly rolling: UsageWindow;
  readonly weekly: UsageWindow;
  readonly monthly: UsageWindow;
}

/** A connected credential, as far as selection is concerned. */
export interface AccountInfo {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
}

/** A connected credential plus everything learned about it at runtime. */
export interface Account {
  id: string;
  label: string;
  disabled: boolean;
  usage: Usage | null;
  /** When `usage` was last set, in ms since the epoch. Null means never. */
  checkedAt: number | null;
  invalidKey: boolean;
  /** Selection is blocked until this time even though usage is unknown. */
  cooldownUntil: number | null;
}

export function createAccount(info: AccountInfo): Account {
  return {
    id: info.id,
    label: info.label,
    disabled: info.disabled,
    usage: null,
    checkedAt: null,
    invalidKey: false,
    cooldownUntil: null,
  };
}
