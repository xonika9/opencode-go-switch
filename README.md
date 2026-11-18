<p align="center">
  <img src="assets/opencode-go-autoswitch-hero.jpg" alt="Go Switch: Limits hit? Keep coding." width="100%">
</p>

# Go Switch (opencode-go-autoswitch)

[![CI workflow status](https://github.com/xonika9/opencode-go-autoswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/xonika9/opencode-go-autoswitch/actions/workflows/ci.yml)

OpenCode Go meters usage in three windows: a rolling 5-hour window, a weekly window, and a monthly window. With one subscription, a window eventually runs out in the middle of a session. With several subscriptions, you can keep working, but switching accounts by hand drops the provider's prompt cache, so the next request starts colder.

This plugin makes that switch for you. It keeps you on the account you are already using while it still has headroom, and when that account actually runs out, it re-sends the failed request with the next key inside the same request. The model and provider stay the same; only the account changes.

> [!IMPORTANT]
> This is an independent project. It is not made, supported, or endorsed by OpenCode.

## What it does

- **Stays put while there is headroom.** Every switch drops the prompt cache, so the plugin never moves to another account just because that account looks fresher. Your current account stays current until one of its windows is exhausted.
- **Moves to the account that resets soonest.** When a switch is needed, the next account is the eligible one whose monthly window resets earliest. An account with an unknown monthly reset goes last. Ties fall back to label, then id.
- **Retries inside the request.** On a quota limit (`429` or `402`) or an invalid key (`401` or `403`), the plugin picks the next eligible account and retries the same request with its key. It repeats until the response is not a limit error or no candidate is left, and then returns the original provider error.
- **Keeps OpenCode's UI truthful.** Every switch marks the chosen credential active in OpenCode, so the account shown in the interface is the account actually used. A failed activation is swallowed; the request still goes through.
- **Remembers across restarts.** The current credential id is kept in plugin storage and restored when OpenCode starts again.
- **Leaves manual switching alone.** Activating a credential in the UI does not change the plugin's choice. Explicit control is the `go_accounts` tool with `select`.

## Requirements

- **OpenCode 2.3.0 or newer.** The plugin is built and tested against the 2.3.0 plugin API and accepts `@opencode/plugin` `>=2.3.0 <3`. `effect` is a peer dependency as well, so the plugin shares the host's Effect runtime instead of loading a second copy.
- **At least one OpenCode Go account** saved as an `opencode-go` credential, for example through `opencode auth login`. Switching needs two or more; with one account the plugin still reports status but has nowhere to go.
- **Bun**, for development and tests only. OpenCode runs the plugin itself.

## Install

Add the plugin to the `plugins` list in your OpenCode configuration (`opencode.jsonc`), pointing at the directory that contains this repository:

```jsonc
{
  "plugins": [
    { "package": "file:///path/to/opencode-go-autoswitch" }
  ]
}
```

The same entry accepts a package name or a Git specifier when your OpenCode can resolve it:

```jsonc
{
  "plugins": [
    { "package": "opencode-go-autoswitch" }
    // or: { "package": "github:xonika9/opencode-go-autoswitch" }
  ]
}
```

Options go in the same entry:

```jsonc
{
  "plugins": [
    {
      "package": "file:///path/to/opencode-go-autoswitch",
      "options": {
        "pollIntervalMs": 300000,
        "toast": true
      }
    }
  ]
}
```

Restart OpenCode after changing the configuration. The package entry points point at the compiled files in `dist`, so run `bun run build` in a local clone and keep the directory where you put it.

## Options

All options are optional.

| Option | Default | Effect |
| --- | --- | --- |
| `pollIntervalMs` | `300000` (5 minutes) | How often every account's usage is refreshed in the background. Usage is also read at startup and right after a limit error. |
| `usageTimeoutMs` | `5000` | Timeout for a single usage request. A timeout counts as unavailable usage, not as an exhausted account. |
| `fallbackCooldownMs` | `900000` (15 minutes) | How long an account is set aside after a limit error when neither usage data nor `Retry-After` says when it recovers. |
| `usageUrl` | `https://opencode.ai/zen/go/v1/usage` | Usage endpoint. Change it only if the endpoint moves. |
| `integrationID` | `opencode-go` | Integration whose credentials are the accounts. |
| `providerID` | `opencode-go` | Provider whose requests are switched between accounts. |
| `toast` | `true` | Show a short notification when the account changes. |

## The `go_accounts` tool

Ask the agent to show the accounts:

```text
show my Go accounts
```

Without arguments the tool refreshes usage if it is missing or stale and returns plain text. For each account it shows the label, the 5-hour, weekly, and monthly percentages, the monthly reset date in ISO form with the relative time, and a state:

- `current` — the account in use;
- `eligible` — has headroom in all three windows;
- `exhausted` — names the window and when it resets;
- `invalid key` or `disabled` — cannot be used until fixed;
- `usage unknown` — OpenCode Go did not return a usable usage record.

It also names the current account and the reason it is current, such as sticky headroom, a specific monthly limit that caused a switch, or an explicit selection.

To choose an account yourself:

```text
select <account label> in go_accounts
```

`select` makes that account current even if another account looks better. It persists the choice, marks the credential active, and sends the same notification as an automatic switch. An unknown label returns an error listing the labels that exist.

## How selection works

1. An account is eligible while it has headroom in all three Go windows. A disabled account or one with an invalid key is not eligible.
2. While the current account is eligible, it stays current.
3. When the current account hits a limit, the plugin switches to the eligible account with the earliest monthly reset. Accounts with an unknown monthly reset go last; ties resolve by label, then id.
4. An account becomes eligible again once the window it hit has reset.
5. The switch happens inside the failed request. If every account is exhausted, the original OpenCode or provider error is returned.
6. On each switch the chosen credential is marked active in OpenCode and, unless `toast` is off, a short notification names the account and the reason.

## Usage data

The plugin reads `GET https://opencode.ai/zen/go/v1/usage` with the account key as a bearer token. When a credential's metadata names a `server`, the request goes to that server's origin instead of the default endpoint, and an `orgID` in the metadata is sent as `x-opencode-org-id`. A usage URL that is not `https:`, or one that does not parse, is never requested and counts as unknown usage. The plugin expects three windows (`rolling`, `weekly`, `monthly`), each with a status, a percentage from 0 to 100, and a reset time as an ISO string or epoch milliseconds.

This endpoint is undocumented. It can change or disappear without notice. The plugin treats it as an optimization, not a dependency:

- a network error, timeout, HTTP error, redirect, oversized body, or unexpected shape means "usage unknown" for that account and nothing else breaks;
- when usage is unknown, the plugin still switches on the provider's own limit responses (`429`, `402`) and on invalid-key responses (`401`, `403`);
- a `401` from the usage endpoint marks the key invalid until a later poll succeeds;
- a `403` from the usage endpoint means the endpoint has no usage data for that key, so usage stays unknown and the key is not marked invalid;
- responses are capped at 64 KiB while reading, so a broken endpoint cannot exhaust memory.

## Privacy

- Go keys stay in OpenCode's credential store. The plugin resolves them through the plugin API and holds them in memory only.
- Keys are never written to plugin storage, logs, notifications, tool output, error messages, or tests.
- **The plugin makes no network requests of its own besides usage polls** to the configured endpoint (`opencode.ai` by default). A retry re-sends the provider request already in flight, with another key. There is no telemetry.
- Notifications and status text contain labels, percentages, window names, and reset times, never key material.

## Limitations

- **No toasts in T3 Code and some other clients.** Clients that do not render plugin notifications show nothing on a switch. Use the `go_accounts` tool to see the current account and why it is current.
- **The usage endpoint is unofficial.** If it changes shape, the tool reports `usage unknown` and switching falls back to provider limit errors.
- **A switch is not free.** It drops the provider's prompt cache. The sticky rule exists to make switches rare, not invisible.
- **One integration and one provider.** The plugin watches `opencode-go` by default; the ids are configurable, but other integrations are not supported.
- **Verified against OpenCode 2.3.0.** Later OpenCode versions may change the plugin API or the hook shapes this plugin depends on.

## Development

```bash
bun install
bun run typecheck
bun test
bun run check
bun run build
```

Tests use a fake network and a fake plugin context: no real keys, no real requests. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

[MIT](LICENSE).
