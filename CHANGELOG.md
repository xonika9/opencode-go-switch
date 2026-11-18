# Changelog

## Unreleased

- Selection: eligible accounts still come first by earliest monthly reset, but an eligible account without a usable monthly reset now sorts ahead of every account whose usage is unknown. Accounts with unknown usage are offered after all eligible ones, in label order. A cooldown after an unexplained limit error is reported as cooling down, separately from an exhausted Go window.
- Package: publishes the compiled `dist` build, with `exports` for the server, TUI, and RPC entries, and a `build` script. `@opencode/plugin` and `effect` are peer dependencies as well as dev dependencies, so the plugin shares the host's Effect runtime instead of loading a second copy.
- Usage reader: a `403` from the usage endpoint now means unknown usage instead of an invalid key.
- Usage reader: `resetsAt` accepts epoch milliseconds as well as an ISO string.
- Usage reader: a credential's `server` metadata decides the usage URL and its `orgID` is sent as `x-opencode-org-id`; redirects are never followed, and a usage URL that is not `https:` is never requested.

## 1.0.0

Initial release.

- Keeps the current OpenCode Go account while all three Go windows still have headroom, so ordinary requests do not lose the provider prompt cache.
- When an account runs out, switches to the eligible account with the earliest monthly reset and re-sends the failed request with the next key inside the same request.
- Reads quota windows from the Go usage endpoint, with polling, and falls back to the provider's own limit errors when usage data is unavailable.
- Persists the current account across restarts and keeps OpenCode's active credential in sync on every switch.
- Adds the `go_accounts` tool: account status, the current account and the reason, and an explicit `select` to choose an account.
- Shows a short notification on automatic and explicit switches.
- Never stores, logs, or returns API keys.
