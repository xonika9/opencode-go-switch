# Changelog

## Unreleased

## 1.0.0

Initial release.

- Keeps the current OpenCode Go account while all three Go windows still have headroom, so ordinary requests do not lose the provider prompt cache.
- When an account runs out, switches to the eligible account with the earliest monthly reset and re-sends the failed request with the next key inside the same request.
- Reads quota windows from the Go usage endpoint, with polling, and falls back to the provider's own limit errors when usage data is unavailable.
- Persists the current account across restarts and keeps OpenCode's active credential in sync on every switch.
- Adds the `go_accounts` tool: account status, the current account and the reason, and an explicit `select` to choose an account.
- Shows a short notification on automatic and explicit switches.
- Never stores, logs, or returns API keys.
